//! Relay — axum router that forwards `/v1/chat/completions` to a
//! configured upstream and captures both directions.
//!
//! Single-route HTTP relay (no MITM, no TLS). The agent (e.g. opencode)
//! sees a normal OpenAI-compat endpoint; the upstream (e.g. LMStudio
//! `:1234`) sees a normal client. Capture happens out-of-band.

use std::sync::Arc;
use std::time::SystemTime;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::capture::{
    extract_turns, parse_sse_to_response, Capture, ChatCompletionsRequest,
    ChatCompletionsResponse, OtlpSpanInputs,
};

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Upstream OpenAI-compat URL, e.g. `http://127.0.0.1:1234/v1/chat/completions`.
    pub upstream_url: String,
    /// Header name the caller writes the session UUID into.
    /// Defaults to `x-session-id`.
    pub session_header: String,
    /// Header name the caller writes the service identifier into
    /// (becomes the OTel `service.name` resource attribute and the
    /// session's `agent_name`). Defaults to `x-service-name`.
    pub service_header: String,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            upstream_url: "http://127.0.0.1:1234/v1/chat/completions".to_string(),
            session_header: "x-session-id".to_string(),
            service_header: "x-service-name".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct LlmRelay {
    cfg: Arc<RelayConfig>,
    capture: Arc<Capture>,
    http: reqwest::Client,
}

impl LlmRelay {
    pub fn new(cfg: RelayConfig, capture: Arc<Capture>) -> Self {
        Self {
            cfg: Arc::new(cfg),
            capture,
            http: reqwest::Client::new(),
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/chat/completions", post(handle_chat_completions))
            .fallback(handle_unimplemented)
            .with_state(self)
    }
}

async fn handle_chat_completions(
    State(relay): State<LlmRelay>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let session_id = extract_header(&headers, &relay.cfg.session_header);
    let service_name = extract_header(&headers, &relay.cfg.service_header);

    // Parse for capture; if it fails, still forward verbatim. Telemetry
    // must never reject an otherwise-valid request.
    let parsed_req: Option<ChatCompletionsRequest> = serde_json::from_str(&body).ok();

    let started_at = SystemTime::now();
    let upstream_resp = relay
        .http
        .post(&relay.cfg.upstream_url)
        .header("content-type", "application/json")
        .body(body.clone())
        .send()
        .await;

    let resp = match upstream_resp {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "upstream relay failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "error": { "message": format!("relay upstream failed: {e}") }
                })),
            )
                .into_response();
        }
    };

    let status = resp.status();
    let upstream_content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned();
    let is_sse = upstream_content_type
        .as_ref()
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("text/event-stream"))
        .unwrap_or(false);

    if is_sse {
        // Streaming response: tee bytes through to the client live, and
        // accumulate a copy server-side. Once the upstream stream ends,
        // parse the accumulated SSE buffer into a synthetic response and
        // run the same capture path the non-streaming branch uses. This
        // keeps the agent's UX (token-by-token output) intact while
        // making opencode + any other AI-SDK client visible to analytics.
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);
        let relay_for_task = relay.clone();
        let parsed_req_for_task = parsed_req;
        let session_id_for_task = session_id;
        let service_name_for_task = service_name;
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.extend_from_slice(&bytes);
                        if tx.send(Ok(bytes)).await.is_err() {
                            // Client hung up — keep accumulating so we
                            // still capture what the upstream produced,
                            // but stop trying to forward.
                            while let Some(c) = stream.next().await {
                                if let Ok(b) = c {
                                    buf.extend_from_slice(&b);
                                }
                            }
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(std::io::Error::other(e.to_string())))
                            .await;
                        return;
                    }
                }
            }
            drop(tx);

            let resp_text = String::from_utf8_lossy(&buf).to_string();
            let parsed_resp = parse_sse_to_response(&resp_text);
            run_capture(
                &relay_for_task,
                parsed_req_for_task,
                parsed_resp,
                session_id_for_task,
                service_name_for_task,
                started_at,
                status.as_u16(),
            )
            .await;
        });

        let body_stream = Body::from_stream(ReceiverStream::new(rx));
        let mut response = Response::new(body_stream);
        *response.status_mut() = status;
        if let Some(ct) = upstream_content_type {
            response.headers_mut().insert(header::CONTENT_TYPE, ct);
        } else {
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream"),
            );
        }
        // SSE clients (and intermediaries) do better with explicit
        // no-cache + identity transfer hints.
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return response;
    }

    // Non-streaming path: collect, parse JSON, capture, return JSON verbatim.
    let resp_text = resp.text().await.unwrap_or_default();
    let parsed_resp: Option<ChatCompletionsResponse> = serde_json::from_str(&resp_text).ok();

    run_capture(
        &relay,
        parsed_req,
        parsed_resp,
        session_id,
        service_name,
        started_at,
        status.as_u16(),
    )
    .await;

    let json: JsonValue =
        serde_json::from_str(&resp_text).unwrap_or(JsonValue::String(resp_text));
    (status, Json(json)).into_response()
}

/// Run the capture path (storage + OTLP) when all the inputs needed for
/// a captured turn are present. Shared by the streaming and
/// non-streaming branches so the same set of attributes always lands.
async fn run_capture(
    relay: &LlmRelay,
    req: Option<ChatCompletionsRequest>,
    resp: Option<ChatCompletionsResponse>,
    session_id: Option<String>,
    service_name: Option<String>,
    started_at: SystemTime,
    status_code: u16,
) {
    let (Some(req), Some(rsp), Some(sid)) = (req, resp, session_id) else {
        return;
    };

    let trace_id = format!("{:032x}", Uuid::new_v4().as_u128());
    let span_id = format!(
        "{:016x}",
        (Uuid::new_v4().as_u128() & 0xffff_ffff_ffff_ffff)
    );
    let turns = extract_turns(&req, &rsp, &sid, &trace_id, &span_id);
    if let Err(e) = relay.capture.persist(&turns) {
        tracing::warn!(error = %e, "prompt body persist failed");
    }

    let end_at = SystemTime::now();
    let span_inputs = OtlpSpanInputs {
        session_id: sid,
        trace_id,
        span_id,
        model: req.model.clone(),
        gen_ai_system: derive_gen_ai_system(&relay.cfg.upstream_url),
        prompt_tokens: rsp.usage.as_ref().and_then(|u| u.prompt_tokens),
        completion_tokens: rsp.usage.as_ref().and_then(|u| u.completion_tokens),
        start_unix_nano: unix_nanos(started_at),
        end_unix_nano: unix_nanos(end_at),
        status_ok: (200..300).contains(&status_code),
    };
    let _ = relay
        .capture
        .emit_otlp_with_service(&span_inputs, service_name.as_deref())
        .await;
}

async fn handle_unimplemented() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": {
                "message": "gctrl-proxy LLM relay only supports POST /v1/chat/completions today.",
                "spec": "vault/specs/implementation/llm-relay.md"
            }
        })),
    )
}

fn extract_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn unix_nanos(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Best-effort `gen_ai.system` derivation from the upstream URL host.
/// Returns `None` rather than guessing wrong — operators can always
/// add a per-request override later.
fn derive_gen_ai_system(upstream_url: &str) -> Option<String> {
    let lower = upstream_url.to_lowercase();
    if lower.contains("127.0.0.1:1234") || lower.contains("localhost:1234") {
        Some("lmstudio".into())
    } else if lower.contains("api.openai.com") {
        Some("openai".into())
    } else if lower.contains("api.anthropic.com") {
        Some("anthropic".into())
    } else if lower.contains("ollama") || lower.contains(":11434") {
        Some("ollama".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use gctrl_storage::DuckDbStore;
    use tower::ServiceExt;

    use crate::capture::CaptureConfig;

    fn test_relay(upstream_url: &str) -> (LlmRelay, Arc<DuckDbStore>) {
        let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let capture = Arc::new(Capture::new(
            Arc::clone(&store),
            CaptureConfig {
                // Point OTLP at an unreachable host so emit_otlp logs +
                // returns Ok without affecting the test outcome.
                kernel_otlp_url: "http://127.0.0.1:1/v1/traces".to_string(),
                default_service_name: "test-svc".to_string(),
            },
        ));
        let relay = LlmRelay::new(
            RelayConfig {
                upstream_url: upstream_url.to_string(),
                session_header: "x-session-id".to_string(),
                service_header: "x-service-name".to_string(),
            },
            capture,
        );
        (relay, store)
    }

    #[tokio::test]
    async fn unimplemented_path_returns_501_with_spec_pointer() {
        let (relay, _) = test_relay("http://127.0.0.1:1");
        let app = relay.router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/embeddings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let body: JsonValue = serde_json::from_slice(&bytes).unwrap();
        assert!(body["error"]["spec"]
            .as_str()
            .unwrap()
            .contains("llm-relay"));
    }

    #[tokio::test]
    async fn relay_captures_turns_and_returns_upstream_body() {
        // Spin up a tiny upstream that mimics LMStudio's response shape.
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_url = format!("http://{}/v1/chat/completions", upstream_addr);

        tokio::spawn(async move {
            let upstream_app: Router = Router::new().route(
                "/v1/chat/completions",
                post(|| async {
                    Json(serde_json::json!({
                        "id": "cmpl-1",
                        "model": "google/gemma-3-26b",
                        "choices": [{
                            "index": 0,
                            "message": { "role": "assistant", "content": "hi" }
                        }],
                        "usage": { "prompt_tokens": 12, "completion_tokens": 3 }
                    }))
                }),
            );
            axum::serve(upstream, upstream_app).await.unwrap();
        });

        // Give the upstream a moment to bind.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (relay, store) = test_relay(&upstream_url);
        let app = relay.router();

        let req_body = serde_json::json!({
            "model": "google/gemma-3-26b",
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .header("x-session-id", "sess-test")
                    .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let body: JsonValue = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], "hi");

        let rows = store.list_prompt_bodies_for_session("sess-test").unwrap();
        assert_eq!(rows.len(), 2, "one user turn + one assistant turn");
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[1].role, "assistant");
        assert_eq!(rows[1].tokens, Some(3));
    }

    #[tokio::test]
    async fn relay_captures_streaming_sse_response() {
        // Simulates an LMStudio-style streaming chat completion. The
        // upstream emits SSE chunks; the relay must pass the bytes
        // through unchanged AND capture turns from the assembled
        // content once the stream ends.
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_url = format!("http://{}/v1/chat/completions", upstream_addr);

        tokio::spawn(async move {
            let upstream_app: Router = Router::new().route(
                "/v1/chat/completions",
                post(|| async {
                    let sse = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}],\"model\":\"google/gemma-4-31b\"}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"po\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ng\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n\
data: [DONE]\n\n";
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        sse,
                    )
                }),
            );
            axum::serve(upstream, upstream_app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (relay, store) = test_relay(&upstream_url);
        let app = relay.router();

        let req_body = serde_json::json!({
            "model": "google/gemma-4-31b",
            "stream": true,
            "messages": [{ "role": "user", "content": "ping" }]
        });

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .header("x-session-id", "sess-stream")
                    .header("x-service-name", "opencode")
                    .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(
            ct.contains("text/event-stream"),
            "expected streaming content-type, got {ct:?}"
        );

        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&bytes);
        // Bytes are forwarded verbatim — opencode keeps its streaming UX.
        assert!(body_str.contains("\"po\""));
        assert!(body_str.contains("\"ng\""));
        assert!(body_str.contains("[DONE]"));

        // Capture happens in a spawned task after the stream ends.
        // Poll briefly so the test isn't a flake on slow runners.
        let mut rows = Vec::new();
        for _ in 0..40 {
            rows = store.list_prompt_bodies_for_session("sess-stream").unwrap();
            if !rows.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert_eq!(rows.len(), 2, "user prompt + assembled assistant reply");
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].content, "ping");
        assert_eq!(rows[1].role, "assistant");
        assert_eq!(
            rows[1].content, "pong",
            "deltas should be concatenated into the full reply"
        );
        assert_eq!(rows[1].tokens, Some(2));
        assert_eq!(rows[0].tokens, Some(7));
    }

    #[tokio::test]
    async fn relay_without_session_header_still_forwards() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_url = format!("http://{}/v1/chat/completions", upstream_addr);

        tokio::spawn(async move {
            let upstream_app: Router = Router::new().route(
                "/v1/chat/completions",
                post(|| async { Json(serde_json::json!({ "ok": true })) }),
            );
            axum::serve(upstream, upstream_app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (relay, store) = test_relay(&upstream_url);
        let app = relay.router();

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "model": "x",
                            "messages": [{ "role": "user", "content": "hi" }]
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        // No session header → no capture rows, but the request still succeeds.
        let rows = store.list_prompt_bodies_for_session("sess-test").unwrap();
        assert!(rows.is_empty());
    }
}
