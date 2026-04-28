//! Capture — turn raw OpenAI-compat request/response bodies into
//! `PromptBody` rows + emit an OTLP span to the kernel's receiver.
//!
//! Pure-ish: the body parsing has no I/O and is tested in isolation.
//! `persist` and `emit_otlp` do I/O and never block the request loop —
//! errors are logged and swallowed. Telemetry must not break the agent.

use std::sync::Arc;

use chrono::Utc;
use gctrl_core::{GctlError, PromptBody, Result};
use gctrl_storage::DuckDbStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CaptureConfig {
    pub kernel_otlp_url: String,
    /// Fallback `service.name` resource attribute when the request
    /// doesn't supply one via header. Kept neutral so the relay
    /// doesn't bake in any one client.
    pub default_service_name: String,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            kernel_otlp_url: "http://localhost:4318/v1/traces".to_string(),
            default_service_name: "llm-client".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CapturedTurn {
    pub session_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub turn_ordinal: i32,
    pub role: String,
    pub content: String,
    pub tokens: Option<i32>,
}

impl CapturedTurn {
    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        // Normalize: trim + lowercase whitespace runs are a future
        // concern; for now hash the raw content so equal text matches.
        hasher.update(self.content.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    pub fn to_prompt_body(&self) -> PromptBody {
        PromptBody {
            id: Uuid::new_v4().to_string(),
            session_id: self.session_id.clone(),
            span_id: Some(self.span_id.clone()),
            trace_id: Some(self.trace_id.clone()),
            turn_ordinal: self.turn_ordinal,
            role: self.role.clone(),
            content: self.content.clone(),
            fingerprint: self.fingerprint(),
            tokens: self.tokens,
            created_at: Utc::now(),
        }
    }
}

// --- OpenAI-compat request/response shapes (minimal, parse-only what we need) ---

#[derive(Debug, Deserialize, Serialize)]
pub struct ChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    /// Either a plain string or a structured content array — we keep
    /// the raw JSON value and stringify for storage.
    pub content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct ChatCompletionsResponse {
    #[serde(default)]
    pub choices: Vec<ChatChoice>,
    #[serde(default)]
    pub usage: Option<ChatUsage>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatChoice {
    #[serde(default)]
    pub message: Option<ChatMessage>,
}

#[derive(Debug, Deserialize)]
pub struct ChatUsage {
    #[serde(default)]
    pub prompt_tokens: Option<i32>,
    #[serde(default)]
    pub completion_tokens: Option<i32>,
}

/// Extract turns from a request + response pair. Pure function — no I/O.
/// Caller supplies the session/trace/span ids to stamp on each turn.
pub fn extract_turns(
    req: &ChatCompletionsRequest,
    resp: &ChatCompletionsResponse,
    session_id: &str,
    trace_id: &str,
    span_id: &str,
) -> Vec<CapturedTurn> {
    let mut turns = Vec::with_capacity(req.messages.len() + 1);
    let total_prompt_tokens = resp.usage.as_ref().and_then(|u| u.prompt_tokens);

    for (i, msg) in req.messages.iter().enumerate() {
        turns.push(CapturedTurn {
            session_id: session_id.to_string(),
            trace_id: trace_id.to_string(),
            span_id: span_id.to_string(),
            turn_ordinal: i as i32,
            role: msg.role.clone(),
            content: stringify_content(&msg.content),
            // Per-turn tokens aren't reported by the OpenAI shape;
            // attach the aggregate prompt_tokens to the last input
            // turn so it's recoverable, leave others NULL.
            tokens: if i + 1 == req.messages.len() {
                total_prompt_tokens
            } else {
                None
            },
        });
    }

    if let Some(choice) = resp.choices.first() {
        if let Some(msg) = &choice.message {
            turns.push(CapturedTurn {
                session_id: session_id.to_string(),
                trace_id: trace_id.to_string(),
                span_id: span_id.to_string(),
                turn_ordinal: req.messages.len() as i32,
                role: msg.role.clone(),
                content: stringify_content(&msg.content),
                tokens: resp.usage.as_ref().and_then(|u| u.completion_tokens),
            });
        }
    }

    turns
}

fn stringify_content(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// --- SSE streaming response shapes ---
//
// Streaming chat completions arrive as `data: {json}\n\n` lines, each carrying
// a partial choice (`delta.content`) and (per OpenAI 2024-04 onward) an
// optional final `usage` chunk. LMStudio sends usage by default; OpenAI cloud
// requires `stream_options.include_usage: true`. The relay does not require
// usage to capture turns — it just leaves `tokens` NULL when absent.

#[derive(Debug, Deserialize)]
struct ChatCompletionsChunk {
    #[serde(default)]
    choices: Vec<ChatChunkChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatChunkChoice {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    delta: Option<ChatChunkDelta>,
}

#[derive(Debug, Deserialize)]
struct ChatChunkDelta {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

/// Parse an OpenAI-compatible SSE `text/event-stream` body into a synthetic
/// non-streaming [`ChatCompletionsResponse`] suitable for [`extract_turns`].
///
/// Returns `None` if no parseable `data:` chunks are found (caller should
/// fall back to JSON parsing). `data: [DONE]` is treated as terminator and
/// non-JSON `data:` lines (LMStudio occasionally emits keepalives) are
/// skipped silently — telemetry must never reject an otherwise-valid stream.
pub fn parse_sse_to_response(body: &str) -> Option<ChatCompletionsResponse> {
    use std::collections::BTreeMap;

    let mut content_by_choice: BTreeMap<u32, String> = BTreeMap::new();
    let mut role_by_choice: BTreeMap<u32, String> = BTreeMap::new();
    let mut usage: Option<ChatUsage> = None;
    let mut model: Option<String> = None;
    let mut saw_chunk = false;

    for line in body.lines() {
        let payload = match line.strip_prefix("data:").map(str::trim) {
            Some(p) => p,
            None => continue,
        };
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let chunk: ChatCompletionsChunk = match serde_json::from_str(payload) {
            Ok(c) => c,
            Err(_) => continue,
        };
        saw_chunk = true;
        if let Some(m) = chunk.model {
            if model.is_none() {
                model = Some(m);
            }
        }
        if let Some(u) = chunk.usage {
            usage = Some(u);
        }
        for choice in chunk.choices {
            if let Some(delta) = choice.delta {
                if let Some(role) = delta.role {
                    role_by_choice
                        .entry(choice.index)
                        .or_insert(role);
                }
                if let Some(content) = delta.content {
                    content_by_choice
                        .entry(choice.index)
                        .or_default()
                        .push_str(&content);
                }
            }
        }
    }

    if !saw_chunk {
        return None;
    }

    let choices = content_by_choice
        .into_iter()
        .map(|(idx, content)| {
            let role = role_by_choice
                .remove(&idx)
                .unwrap_or_else(|| "assistant".to_string());
            ChatChoice {
                message: Some(ChatMessage {
                    role,
                    content: serde_json::Value::String(content),
                }),
            }
        })
        .collect();

    Some(ChatCompletionsResponse {
        choices,
        usage,
        model,
    })
}

// --- Generic OpenAI-compat exchange capture (relay + driver-llm) ---
//
// Both the LLM relay and the kernel's `driver-llm` HTTP route forward
// OpenAI-compat `/v1/chat/completions` calls to a configurable upstream.
// They share the same capture target — `prompt_bodies` rows + a single
// OTLP generation span — so the persist/emit logic lives here, not in
// either caller. Skipping capture is silent and never blocks the agent
// loop: missing session id, unparseable JSON, or a downstream OTLP failure
// all degrade to "request still served, telemetry quietly dropped."

use std::time::SystemTime;

/// Run the capture path for one OpenAI-compat chat-completions exchange.
///
/// All fields that block capture are passed as `Option`/`Result` so a
/// caller never has to short-circuit upstream — the function decides
/// internally whether enough is present to write a row. This is the
/// single entry point the relay and `driver-llm` both call.
///
/// `upstream_url` is used only for `gen_ai.system` heuristics
/// (`lmstudio`/`ollama`/`openai`/...); pass the URL the request was
/// forwarded to, not the URL the client called.
pub async fn capture_oai_exchange(
    capture: &Capture,
    upstream_url: &str,
    req_body_text: &str,
    resp_body_text: &str,
    session_id: Option<&str>,
    service_name: Option<&str>,
    started_at: SystemTime,
    status_code: u16,
) {
    let Some(sid) = session_id else { return };
    let Ok(req) = serde_json::from_str::<ChatCompletionsRequest>(req_body_text) else {
        return;
    };
    let Ok(rsp) = serde_json::from_str::<ChatCompletionsResponse>(resp_body_text) else {
        return;
    };

    let trace_id = format!("{:032x}", Uuid::new_v4().as_u128());
    let span_id = format!(
        "{:016x}",
        (Uuid::new_v4().as_u128() & 0xffff_ffff_ffff_ffff)
    );
    let turns = extract_turns(&req, &rsp, sid, &trace_id, &span_id);
    if let Err(e) = capture.persist(&turns) {
        tracing::warn!(error = %e, "prompt body persist failed");
    }

    let span_inputs = OtlpSpanInputs {
        session_id: sid.to_string(),
        trace_id,
        span_id,
        model: req.model.clone(),
        gen_ai_system: derive_gen_ai_system_from_url(upstream_url),
        prompt_tokens: rsp.usage.as_ref().and_then(|u| u.prompt_tokens),
        completion_tokens: rsp.usage.as_ref().and_then(|u| u.completion_tokens),
        start_unix_nano: unix_nanos(started_at),
        end_unix_nano: unix_nanos(SystemTime::now()),
        status_ok: (200..300).contains(&status_code),
    };
    let _ = capture
        .emit_otlp_with_service(&span_inputs, service_name)
        .await;
}

/// Best-effort `gen_ai.system` derivation from the upstream URL host.
/// Returns `None` rather than guessing wrong — operators can always
/// add a per-request override later.
pub fn derive_gen_ai_system_from_url(upstream_url: &str) -> Option<String> {
    let lower = upstream_url.to_lowercase();
    if lower.contains("127.0.0.1:1234") || lower.contains("localhost:1234") {
        Some("lmstudio".into())
    } else if lower.contains("api.openai.com") {
        Some("openai".into())
    } else if lower.contains("api.anthropic.com") {
        Some("anthropic".into())
    } else if lower.contains("ollama") || lower.contains(":11434") {
        Some("ollama".into())
    } else if lower.contains("gateway.ai.cloudflare.com") {
        Some("cloudflare-ai-gateway".into())
    } else {
        None
    }
}

fn unix_nanos(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

// --- Capture sink: storage + OTLP ---

pub struct Capture {
    store: Arc<DuckDbStore>,
    cfg: CaptureConfig,
    http: reqwest::Client,
}

impl Capture {
    pub fn new(store: Arc<DuckDbStore>, cfg: CaptureConfig) -> Self {
        Self {
            store,
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn persist(&self, turns: &[CapturedTurn]) -> Result<()> {
        for turn in turns {
            let body = turn.to_prompt_body();
            self.store.insert_prompt_body(&body)?;
        }
        Ok(())
    }

    /// Best-effort OTLP emit. On failure, log and return Ok — the
    /// agent loop must not break because telemetry is down.
    pub async fn emit_otlp(&self, span: &OtlpSpanInputs) -> Result<()> {
        self.emit_otlp_with_service(span, None).await
    }

    /// Same as [`emit_otlp`] but lets the caller override the
    /// `service.name` resource attribute per-request (e.g. from the
    /// `x-service-name` header). Falls back to
    /// `CaptureConfig::default_service_name` when `None`.
    pub async fn emit_otlp_with_service(
        &self,
        span: &OtlpSpanInputs,
        service_name: Option<&str>,
    ) -> Result<()> {
        let svc = service_name.unwrap_or(&self.cfg.default_service_name);
        let payload = build_otlp_payload(span, svc);
        match self
            .http
            .post(&self.cfg.kernel_otlp_url)
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => {
                tracing::warn!(status = %resp.status(), "OTLP emit non-2xx");
                Ok(())
            }
            Err(e) => {
                tracing::warn!(error = %e, "OTLP emit failed");
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct OtlpSpanInputs {
    pub session_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub model: String,
    /// `gen_ai.system` per OpenTelemetry semantic conventions
    /// (e.g. `lmstudio`, `openai`, `anthropic`). Optional — set by the
    /// relay if it can derive it from the upstream URL or request
    /// headers; otherwise omitted.
    pub gen_ai_system: Option<String>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub start_unix_nano: u64,
    pub end_unix_nano: u64,
    pub status_ok: bool,
}

/// Build a minimal OTLP/JSON `ExportTraceServiceRequest` for one
/// generation span. Mirrors the keys the kernel's span_processor
/// reads (`gen_ai.request.model`, `gen_ai.usage.*`, `service.name`,
/// `session.id`).
pub fn build_otlp_payload(s: &OtlpSpanInputs, service_name: &str) -> serde_json::Value {
    let mut attrs = vec![kv_string("gen_ai.request.model", &s.model)];
    if let Some(system) = &s.gen_ai_system {
        attrs.push(kv_string("gen_ai.system", system));
    }
    if let Some(pt) = s.prompt_tokens {
        attrs.push(kv_int("gen_ai.usage.prompt_tokens", pt as i64));
    }
    if let Some(ct) = s.completion_tokens {
        attrs.push(kv_int("gen_ai.usage.completion_tokens", ct as i64));
    }

    serde_json::json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    kv_string("service.name", service_name),
                    kv_string("session.id", &s.session_id),
                ]
            },
            "scopeSpans": [{
                "scope": { "name": "gctrl-proxy" },
                "spans": [{
                    "traceId": s.trace_id,
                    "spanId": s.span_id,
                    "name": "llm.chat.completions",
                    // Numbers, not strings — the kernel's OtlpSpan
                    // deserializes these into u64 directly. Sending
                    // them as JSON strings yields a 422 from the
                    // receiver.
                    "startTimeUnixNano": s.start_unix_nano,
                    "endTimeUnixNano": s.end_unix_nano,
                    "attributes": attrs,
                    "status": {
                        "code": if s.status_ok { 1 } else { 2 }
                    }
                }]
            }]
        }]
    })
}

fn kv_string(k: &str, v: &str) -> serde_json::Value {
    serde_json::json!({ "key": k, "value": { "stringValue": v } })
}

fn kv_int(k: &str, v: i64) -> serde_json::Value {
    // Same as above: the receiver's `OtlpAnyValue.int_value` is `i64`,
    // expecting a JSON number, not a string.
    serde_json::json!({ "key": k, "value": { "intValue": v } })
}

// --- Errors ---

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("storage: {0}")]
    Storage(#[from] GctlError),
    #[error("invalid request body: {0}")]
    InvalidBody(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_two_turns() -> ChatCompletionsRequest {
        ChatCompletionsRequest {
            model: "google/gemma-3-26b".to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: serde_json::Value::String("be terse".to_string()),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: serde_json::Value::String("hello".to_string()),
                },
            ],
            stream: None,
        }
    }

    fn resp_with_usage(prompt: i32, completion: i32) -> ChatCompletionsResponse {
        ChatCompletionsResponse {
            choices: vec![ChatChoice {
                message: Some(ChatMessage {
                    role: "assistant".to_string(),
                    content: serde_json::Value::String("hi".to_string()),
                }),
            }],
            usage: Some(ChatUsage {
                prompt_tokens: Some(prompt),
                completion_tokens: Some(completion),
            }),
            model: Some("google/gemma-3-26b".to_string()),
        }
    }

    #[test]
    fn extract_turns_includes_input_and_assistant_reply() {
        let req = req_two_turns();
        let resp = resp_with_usage(20, 5);
        let turns = extract_turns(&req, &resp, "sess-1", "trace-1", "span-1");

        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "system");
        assert_eq!(turns[1].role, "user");
        assert_eq!(turns[2].role, "assistant");
        assert_eq!(turns[2].content, "hi");
    }

    #[test]
    fn extract_turns_attaches_prompt_tokens_to_last_input_turn() {
        let req = req_two_turns();
        let resp = resp_with_usage(20, 5);
        let turns = extract_turns(&req, &resp, "sess-1", "trace-1", "span-1");

        assert_eq!(turns[0].tokens, None, "system turn has no per-turn count");
        assert_eq!(turns[1].tokens, Some(20), "last input turn carries prompt total");
        assert_eq!(turns[2].tokens, Some(5), "assistant turn carries completion total");
    }

    #[test]
    fn extract_turns_works_with_no_usage() {
        let req = req_two_turns();
        let resp = ChatCompletionsResponse {
            choices: vec![ChatChoice {
                message: Some(ChatMessage {
                    role: "assistant".to_string(),
                    content: serde_json::Value::String("hi".to_string()),
                }),
            }],
            usage: None,
            model: None,
        };
        let turns = extract_turns(&req, &resp, "sess-1", "trace-1", "span-1");

        assert_eq!(turns.len(), 3);
        assert!(turns.iter().all(|t| t.tokens.is_none()));
    }

    #[test]
    fn fingerprint_is_stable_for_same_content() {
        let t1 = CapturedTurn {
            session_id: "s".into(),
            trace_id: "t".into(),
            span_id: "sp".into(),
            turn_ordinal: 0,
            role: "user".into(),
            content: "hello world".into(),
            tokens: None,
        };
        let t2 = CapturedTurn {
            session_id: "different".into(),
            trace_id: "different".into(),
            span_id: "different".into(),
            turn_ordinal: 99,
            role: "user".into(),
            content: "hello world".into(),
            tokens: None,
        };
        assert_eq!(t1.fingerprint(), t2.fingerprint());
    }

    #[test]
    fn parse_sse_assembles_content_and_usage() {
        // LMStudio-style stream: role on first delta, content deltas in
        // the middle, usage on the final pre-[DONE] chunk.
        let sse = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}],\"model\":\"google/gemma-4-31b\"}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"po\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ng\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n\
data: [DONE]\n\n";

        let resp = parse_sse_to_response(sse).expect("parses");
        assert_eq!(resp.choices.len(), 1);
        let msg = resp.choices[0].message.as_ref().unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(stringify_content(&msg.content), "pong");
        assert_eq!(resp.usage.as_ref().unwrap().prompt_tokens, Some(7));
        assert_eq!(resp.usage.as_ref().unwrap().completion_tokens, Some(2));
        assert_eq!(resp.model.as_deref(), Some("google/gemma-4-31b"));
    }

    #[test]
    fn parse_sse_returns_none_for_non_sse_body() {
        // Non-streaming JSON should yield None so the caller falls back
        // to the regular ChatCompletionsResponse parser.
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"hi"}}]}"#;
        assert!(parse_sse_to_response(body).is_none());
    }

    #[test]
    fn parse_sse_skips_keepalive_and_malformed_chunks() {
        // OpenAI sends `: ping` keepalives; LMStudio occasionally emits
        // `data: ` with an empty payload. Neither should derail capture.
        let sse = "\
: keepalive\n\n\
data: \n\n\
data: not-json\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n\
data: [DONE]\n\n";

        let resp = parse_sse_to_response(sse).expect("parses");
        assert_eq!(stringify_content(&resp.choices[0].message.as_ref().unwrap().content), "ok");
    }

    #[test]
    fn build_otlp_payload_includes_required_attrs() {
        let inputs = OtlpSpanInputs {
            session_id: "sess-1".into(),
            trace_id: "0123456789abcdef0123456789abcdef".into(),
            span_id: "0123456789abcdef".into(),
            model: "gemma".into(),
            gen_ai_system: Some("lmstudio".into()),
            prompt_tokens: Some(10),
            completion_tokens: Some(20),
            start_unix_nano: 1_000_000,
            end_unix_nano: 2_000_000,
            status_ok: true,
        };
        let payload = build_otlp_payload(&inputs, "test-svc");

        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"service.name\""));
        assert!(s.contains("\"session.id\""));
        assert!(s.contains("\"gen_ai.request.model\""));
        assert!(s.contains("\"gen_ai.system\""));
        assert!(s.contains("\"gen_ai.usage.prompt_tokens\""));
        assert!(s.contains("\"gen_ai.usage.completion_tokens\""));
    }

    #[test]
    fn build_otlp_payload_omits_gen_ai_system_when_none() {
        let inputs = OtlpSpanInputs {
            session_id: "s".into(),
            trace_id: "t".into(),
            span_id: "sp".into(),
            model: "m".into(),
            gen_ai_system: None,
            prompt_tokens: None,
            completion_tokens: None,
            start_unix_nano: 0,
            end_unix_nano: 0,
            status_ok: true,
        };
        let payload = build_otlp_payload(&inputs, "test-svc");
        let s = serde_json::to_string(&payload).unwrap();
        assert!(!s.contains("gen_ai.system"));
    }

    #[test]
    fn otlp_payload_uses_numeric_times_and_int_values() {
        // Regression: when these fields were stringified, the kernel
        // OTLP receiver returned 422 (its `OtlpSpan` expects u64 / i64
        // JSON numbers). Lock the wire format down so we don't drift.
        let inputs = OtlpSpanInputs {
            session_id: "sess-1".into(),
            trace_id: "t".into(),
            span_id: "s".into(),
            model: "x".into(),
            gen_ai_system: None,
            prompt_tokens: Some(7),
            completion_tokens: Some(3),
            start_unix_nano: 1700000000000000000,
            end_unix_nano: 1700000003000000000,
            status_ok: true,
        };
        let payload = build_otlp_payload(&inputs, "test-svc");
        let span = &payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0];

        assert!(span["startTimeUnixNano"].is_number(), "startTimeUnixNano must be JSON number");
        assert!(span["endTimeUnixNano"].is_number(), "endTimeUnixNano must be JSON number");

        let attrs = span["attributes"].as_array().unwrap();
        let prompt_tokens = attrs.iter().find(|a| a["key"] == "gen_ai.usage.prompt_tokens").unwrap();
        assert!(
            prompt_tokens["value"]["intValue"].is_number(),
            "gen_ai.usage.prompt_tokens intValue must be JSON number"
        );
    }

    #[test]
    fn persist_writes_one_row_per_turn() {
        let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let capture = Capture::new(Arc::clone(&store), CaptureConfig::default());

        let req = req_two_turns();
        let resp = resp_with_usage(20, 5);
        let turns = extract_turns(&req, &resp, "sess-x", "trace-x", "span-x");

        capture.persist(&turns).unwrap();
        let rows = store.list_prompt_bodies_for_session("sess-x").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].turn_ordinal, 0);
        assert_eq!(rows[2].role, "assistant");
    }

    #[test]
    fn structured_content_arrays_are_stringified_not_lost() {
        let req = ChatCompletionsRequest {
            model: "x".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: serde_json::json!([
                    { "type": "text", "text": "describe" },
                    { "type": "image_url", "image_url": { "url": "data:..." } }
                ]),
            }],
            stream: None,
        };
        let resp = ChatCompletionsResponse {
            choices: vec![],
            usage: None,
            model: None,
        };
        let turns = extract_turns(&req, &resp, "s", "t", "sp");
        assert_eq!(turns.len(), 1);
        assert!(turns[0].content.contains("image_url"));
    }
}
