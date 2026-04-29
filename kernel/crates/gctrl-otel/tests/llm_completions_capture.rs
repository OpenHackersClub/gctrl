//! Integration test for `/api/llm/completions` driver-llm capture.
//!
//! Spec: `vault/specs/implementation/llm-relay.md` § "Convergence with
//! driver-llm". When the kernel forwards a chat-completions request to a
//! local upstream, an `x-session-id` + `x-service-name` header pair on
//! the inbound call should make the exchange land in `prompt_bodies`
//! and, by way of the OTLP self-emit, in `/api/sessions`. Without the
//! headers, the request still completes but no rows are written.

use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::routing::post;
use axum::{Json, Router};
use gctrl_otel::create_router_from_arc;
use gctrl_storage::DuckDbStore;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// Both tests below mutate `GCTRL_LLM_LOCAL_URL` and `GCTRL_LLM_PROVIDER`,
/// which are process-global. Cargo runs tests in a binary in parallel by
/// default, so without serialization the second test's `set_var` could
/// race the first test's in-flight `oneshot`. Take this lock for the
/// whole duration of any test that depends on those env vars.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Spawn a tiny stand-in LMStudio that returns a deterministic response.
/// We point the kernel at it with `GCTRL_LLM_LOCAL_URL`, then route the
/// receiver's `/api/llm/completions` through `oneshot`.
async fn spawn_mock_upstream() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/v1/chat/completions");
    tokio::spawn(async move {
        let app: Router = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                Json(serde_json::json!({
                    "id": "cmpl-driver",
                    "model": "google/gemma-4-31b",
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": "ok" }
                    }],
                    "usage": { "prompt_tokens": 11, "completion_tokens": 1 }
                }))
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    url
}

#[tokio::test]
async fn llm_completions_with_session_headers_captures_prompt_bodies() {
    let _guard = env_lock();
    let upstream = spawn_mock_upstream().await;

    // Force the local-first branch and point at our stand-in. The
    // `env_lock` above ensures we don't race the sibling test on the
    // shared GCTRL_LLM_* env vars.
    unsafe {
        std::env::set_var("GCTRL_LLM_PROVIDER", "lmstudio");
        std::env::set_var("GCTRL_LLM_LOCAL_URL", &upstream);
    }

    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let app = create_router_from_arc(Arc::clone(&store));

    let body = serde_json::json!({
        "model": "google/gemma-4-31b",
        "messages": [
            { "role": "system", "content": "be terse" },
            { "role": "user", "content": "ping" }
        ]
    });

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/llm/completions")
                .header("content-type", "application/json")
                .header("x-session-id", "drvl-sess-1")
                .header("x-service-name", "uebermensch")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["choices"][0]["message"]["content"], "ok");

    // Capture is awaited inside the handler, so by the time the response
    // returns the rows are committed.
    let rows = store.list_prompt_bodies_for_session("drvl-sess-1").unwrap();
    assert_eq!(rows.len(), 3, "system + user + assistant");
    assert_eq!(rows[0].role, "system");
    assert_eq!(rows[0].content, "be terse");
    assert_eq!(rows[1].role, "user");
    assert_eq!(rows[1].content, "ping");
    assert_eq!(rows[1].tokens, Some(11));
    assert_eq!(rows[2].role, "assistant");
    assert_eq!(rows[2].content, "ok");
    assert_eq!(rows[2].tokens, Some(1));
}

#[tokio::test]
async fn llm_completions_without_session_header_still_serves_no_capture() {
    let _guard = env_lock();
    let upstream = spawn_mock_upstream().await;
    unsafe {
        std::env::set_var("GCTRL_LLM_PROVIDER", "lmstudio");
        std::env::set_var("GCTRL_LLM_LOCAL_URL", &upstream);
    }

    let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
    let app = create_router_from_arc(Arc::clone(&store));

    let body = serde_json::json!({
        "model": "google/gemma-4-31b",
        "messages": [{ "role": "user", "content": "no-session" }]
    });

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/llm/completions")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    // No session header → no orphan rows. Spec: relay/driver-llm both
    // skip capture rather than write under a synthetic id.
    let any_rows = store.list_prompt_bodies_for_session("").unwrap();
    assert!(any_rows.is_empty());
}
