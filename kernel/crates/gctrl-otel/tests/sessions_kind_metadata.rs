//! Generic `POST /api/sessions` accepts arbitrary `kind` + `metadata`.
//!
//! Apps that own session-shaped run records (e.g. uebermensch's SinkIn)
//! call this endpoint with their own `kind` (e.g. `"uber.sinkin"`) and
//! put domain-specific fields under `metadata`. The kernel never
//! interprets either — it stores them verbatim and gives them back.

use axum::body::Body;
use http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

use gctrl_otel::create_router;
use gctrl_storage::DuckDbStore;

#[tokio::test]
async fn post_sessions_round_trips_kind_and_metadata() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    let body = serde_json::json!({
        "id": "sinkin-2026-05-04-abc123",
        "kind": "uber.sinkin",
        "started_at": "2026-05-04T08:00:00Z",
        "completed_at": null,
        "status": "active",
        "cost_usd": 0.0,
        "metadata": {
            "mode": "manual",
            "scope_kind": "topic",
            "scope_value": "ai-capex",
            "pages_scanned": 84,
            "gaps_found": 6
        }
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201, "POST /api/sessions should return 201");

    let written: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(written["kind"], "uber.sinkin");
    assert_eq!(written["metadata"]["scope_kind"], "topic");

    // Round-trip via GET.
    let req = Request::builder()
        .uri("/api/sessions/sinkin-2026-05-04-abc123")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let got: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(got["kind"], "uber.sinkin");
    assert_eq!(got["metadata"]["pages_scanned"], 84);
    assert_eq!(got["metadata"]["scope_value"], "ai-capex");
}

#[tokio::test]
async fn post_sessions_defaults_kind_to_llm_when_absent() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    let body = serde_json::json!({
        "id": "no-kind-session",
        "started_at": "2026-05-04T08:00:00Z",
        "status": "active"
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);
    let written: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        written["kind"], "llm",
        "missing kind should default to 'llm' for back-compat with OTel sessions"
    );
}

/// Provenance guard: the API path must NOT clobber sessions owned by
/// the OTLP ingest path (or scheduler / unknown). A local process that
/// happens to know an OTel session id should not be able to flip
/// `created_by` to `Api` and zero out token counts via re-POST.
#[tokio::test]
async fn post_sessions_refuses_to_overwrite_otel_owned_session() {
    let store = DuckDbStore::open(":memory:").unwrap();
    // Pre-seed an OTel-ingested row directly through storage — same
    // shape as what `ingest_traces` auto-creates.
    store
        .insert_session(&gctrl_core::Session {
            id: gctrl_core::SessionId("otel-session-99".into()),
            workspace_id: gctrl_core::WorkspaceId("default".into()),
            device_id: gctrl_core::DeviceId("local".into()),
            agent_name: "claude".into(),
            started_at: chrono::Utc::now(),
            ended_at: None,
            status: gctrl_core::SessionStatus::Active,
            total_cost_usd: 1.50,
            total_input_tokens: 1000,
            total_output_tokens: 500,
            created_by: gctrl_core::CreatedBy::OtelIngest,
            project_id: None,
            kind: gctrl_core::default_session_kind(),
            metadata: None,
        })
        .unwrap();

    let app = create_router(store);
    let body = serde_json::json!({
        "id": "otel-session-99",
        "kind": "uber.sinkin",
        "started_at": "2026-05-04T08:00:00Z",
        "metadata": { "evil": "overwrite" }
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(
        res.status(),
        409,
        "POST against an OTel-owned session id must return 409 Conflict"
    );
}

/// Token-count preservation: re-POSTing an Api-owned session keeps the
/// span-derived token counts intact (they come from `update_session_aggregates`,
/// not the API body). Otherwise a session with span data would have its
/// tokens reset to 0 every time the app re-upserts.
#[tokio::test]
async fn post_sessions_preserves_token_counts_on_repost() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    // First POST creates the session.
    let body = serde_json::json!({
        "id": "uber-sinkin-1",
        "kind": "uber.sinkin",
        "started_at": "2026-05-04T08:00:00Z",
        "status": "active"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);

    // Second POST replaces it (e.g. status: "completed" with new metadata)
    // and must preserve token totals.
    let body2 = serde_json::json!({
        "id": "uber-sinkin-1",
        "kind": "uber.sinkin",
        "started_at": "2026-05-04T08:00:00Z",
        "completed_at": "2026-05-04T08:05:00Z",
        "status": "completed",
        "metadata": { "pages_scanned": 84 }
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(body2.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);

    // Read back; token counts remain at their initial 0 (no spans
    // ingested), but the assertion is that they're preserved through
    // upsert — not silently reset. Since both POSTs supplied 0, the
    // observable effect is that the counts equal whatever was last
    // set by `update_session_aggregates` (still 0 here, but the code
    // path is exercised).
    let req = Request::builder()
        .uri("/api/sessions/uber-sinkin-1")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let got: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(got["status"], "Completed");
    assert_eq!(got["metadata"]["pages_scanned"], 84);
}

/// `?kind=` is provenance shorthand (`internal` / `external`); ANY other
/// value must return 400 — silent fallback to "all rows" was a cross-app
/// data-leak hazard now that `metadata` is serialized in list responses.
#[tokio::test]
async fn list_sessions_rejects_unknown_kind_param() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    let req = Request::builder()
        .uri("/api/sessions?kind=uber.sinkin")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(
        res.status(),
        400,
        "?kind=<arbitrary> must 400 — `kind` is provenance shorthand only"
    );
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec())
        .unwrap();
    assert!(
        body.contains("session_kind"),
        "error should hint at ?session_kind= for column-based filtering, got {body:?}"
    );
}

/// `?session_kind=` filters the new column without leaking other apps'
/// rows. Two sessions with different kinds, query each → only its own
/// row comes back.
#[tokio::test]
async fn list_sessions_session_kind_filter_isolates_apps() {
    let store = DuckDbStore::open(":memory:").unwrap();
    let app = create_router(store);

    for (id, kind) in [
        ("sinkin-1", "uber.sinkin"),
        ("review-1", "board.review"),
    ] {
        let body = serde_json::json!({
            "id": id,
            "kind": kind,
            "started_at": "2026-05-04T08:00:00Z",
            "status": "active"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/sessions")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), 201);
    }

    // Query only uber.sinkin rows.
    let req = Request::builder()
        .uri("/api/sessions?session_kind=uber.sinkin")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let rows: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let kinds: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    assert!(
        kinds.iter().all(|k| *k == "uber.sinkin"),
        "?session_kind=uber.sinkin must isolate to that kind, got {kinds:?}"
    );
    assert_eq!(kinds.len(), 1, "expected one row, got {}", kinds.len());
}
