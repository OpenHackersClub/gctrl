//! Integration test for the SSE live-stream endpoints
//! (`/api/sessions/stream`, `/api/sessions/{id}/stream`) per
//! `specs/architecture/apps/gctrl-analytics.md` §5.
//!
//! We don't bring up a full HTTP server — we drive the router via
//! `tower::ServiceExt::oneshot` and read the SSE chunks off the
//! response body. That's enough to verify wire format
//! (`event:` + `id:` + `data:` framing), event emission on ingest,
//! and per-session filtering.

use axum::body::Body;
use gctrl_otel::create_router;
use gctrl_storage::DuckDbStore;
use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn test_app() -> axum::Router {
    let store = DuckDbStore::open(":memory:").unwrap();
    create_router(store)
}

fn otlp_payload(session_id: &str, span_id: &str) -> serde_json::Value {
    serde_json::json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key": "session.id", "value": {"stringValue": session_id}},
                    {"key": "service.name", "value": {"stringValue": "claude-code"}}
                ]
            },
            "scopeSpans": [{
                "spans": [{
                    "traceId": "trace-sse-1",
                    "spanId": span_id,
                    "name": "llm.call",
                    "startTimeUnixNano": 1700000000000000000_u64,
                    "endTimeUnixNano": 1700000003000000000_u64,
                    "attributes": [
                        {"key": "ai.model.id", "value": {"stringValue": "claude-opus-4-6"}},
                        {"key": "ai.tokens.input", "value": {"intValue": 100}},
                        {"key": "ai.tokens.output", "value": {"intValue": 50}}
                    ],
                    "status": {"code": 1}
                }]
            }]
        }]
    })
}

async fn ingest(app: &axum::Router, payload: &serde_json::Value) {
    let req = Request::builder()
        .uri("/v1/traces")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert!(res.status().is_success(), "ingest failed: {}", res.status());
}

/// Read SSE chunks until we have at least `min_events` `event:` lines
/// or the read times out. Returns the concatenated body text.
async fn collect_sse(
    app: axum::Router,
    uri: &str,
    min_events: usize,
    timeout_ms: u64,
) -> String {
    let req = Request::builder()
        .uri(uri)
        .method("GET")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("content-type").and_then(|v| v.to_str().ok()),
        Some("text/event-stream")
    );

    let mut body = res.into_body();
    let mut buf = String::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

    while tokio::time::Instant::now() < deadline {
        let frame_fut = body.frame();
        let frame = match tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            frame_fut,
        )
        .await
        {
            Ok(Some(Ok(f))) => f,
            _ => break,
        };
        if let Some(data) = frame.data_ref() {
            buf.push_str(std::str::from_utf8(data).unwrap_or(""));
        }
        if buf.matches("\nevent: session.").count() >= min_events {
            break;
        }
    }
    buf
}

#[tokio::test]
async fn stream_endpoint_emits_events_for_ingested_spans() {
    let app = test_app();
    let payload = otlp_payload("sse-test-1", "span-001");

    // Spawn the SSE consumer first, then ingest. The broadcast channel
    // only delivers events that arrive after the subscriber is live, so
    // ordering matters here.
    let app_for_stream = app.clone();
    let consumer = tokio::spawn(async move {
        collect_sse(app_for_stream, "/api/sessions/stream", 2, 2_000).await
    });

    // Give the consumer a moment to subscribe.
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    ingest(&app, &payload).await;

    let body = consumer.await.unwrap();

    // Expect at least one `session.started` (auto-create) and one
    // `session.span` (the ingested generation), each with a stable
    // monotonic id.
    assert!(
        body.contains("event: session.started"),
        "missing session.started in body: {body}"
    );
    assert!(
        body.contains("event: session.span"),
        "missing session.span in body: {body}"
    );
    assert!(body.contains("id: 1"), "missing id: 1 frame in body: {body}");
    assert!(
        body.contains("\"session_id\":\"sse-test-1\""),
        "session_id payload missing: {body}"
    );
}

#[tokio::test]
async fn per_session_stream_filters_by_session_id() {
    let app = test_app();
    let pa = otlp_payload("sse-A", "span-A1");
    let pb = otlp_payload("sse-B", "span-B1");

    let app_for_stream = app.clone();
    let consumer = tokio::spawn(async move {
        collect_sse(app_for_stream, "/api/sessions/sse-B/stream", 1, 2_000).await
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    ingest(&app, &pa).await;
    ingest(&app, &pb).await;

    let body = consumer.await.unwrap();

    // Should see B's events but not A's.
    assert!(
        body.contains("\"session_id\":\"sse-B\""),
        "missing B in stream: {body}"
    );
    assert!(
        !body.contains("\"session_id\":\"sse-A\""),
        "leaked A into B-only stream: {body}"
    );
}

#[tokio::test]
async fn end_session_emits_ended_event() {
    let app = test_app();

    // First create a session via ingest so end_session has a row to
    // operate on.
    ingest(&app, &otlp_payload("sse-end", "span-end-1")).await;

    let app_for_stream = app.clone();
    let consumer = tokio::spawn(async move {
        collect_sse(app_for_stream, "/api/sessions/stream", 1, 2_000).await
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // End the session.
    let req = Request::builder()
        .uri("/api/sessions/sse-end/end")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"status":"completed"}"#))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert!(res.status().is_success());

    let body = consumer.await.unwrap();
    assert!(
        body.contains("event: session.ended"),
        "missing session.ended in body: {body}"
    );
    assert!(
        body.contains("\"status\":\"completed\""),
        "missing completed status payload: {body}"
    );
}
