//! Eval substrate HTTP routes — kernel-side data sink for eval runs.
//!
//! Mounts `/api/eval/*` onto the kernel router:
//!
//! - `POST /api/eval/score`    — write a single eval score into `scores`
//! - `GET  /api/eval/metrics`  — list registered eval metrics      (501 — accessor pending)
//! - `POST /api/eval/metrics`  — register/update an eval metric    (501 — accessor pending)
//! - `GET  /api/eval/datasets` — list eval datasets                (501 — accessor pending)
//! - `POST /api/eval/datasets` — create an eval dataset            (501 — accessor pending)
//! - `GET  /api/eval/cases`    — list eval cases (optionally filtered by dataset)
//!                                                                 (501 — accessor pending)
//! - `POST /api/eval/cases`    — register an eval case             (501 — accessor pending)
//! - `GET  /api/eval/runs`     — list eval runs                    (501 — accessor pending)
//! - `POST /api/eval/runs`     — open an eval run                  (501 — accessor pending)
//!
//! The substrate score endpoint is the only handler with a live storage path
//! today: the `scores` table already accepts `eval_substrate` / `eval_harness`
//! sources via the existing `insert_score` accessor. The other four resources
//! (metrics / datasets / cases / runs) have schema landed via PR #122 but no
//! typed `gctrl-storage` accessors yet, so we stub them with a 501 envelope
//! that mirrors `browser_routes`. Real handlers land in a follow-up once the
//! storage surface is extended.
//!
//! Spec: `vault/specs/implementation/kernel/eval-storage.md` §4.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::receiver::AppState;

// ---------------------------------------------------------------------------
// POST /api/eval/score — the load-bearing endpoint.
// ---------------------------------------------------------------------------

/// Score write request from an eval substrate / harness client.
///
/// Mirrors `gctrl_core::Score` plus the optional `eval_run_id` join column
/// added by PR #122. Field names are snake_case to match the existing
/// `/api/analytics/score` payload shape — substrate clients already speak
/// that dialect.
#[derive(Debug, Deserialize)]
struct ScoreRequest {
    /// Optional client-supplied id; defaults to a fresh UUID.
    id: Option<String>,
    /// `"eval_case"` (most common), `"eval_run"`, or any other target_type
    /// the kernel already accepts (`session`, `span`, `task`).
    target_type: String,
    target_id: String,
    /// Metric name — must match a row in `eval_metrics.name` once
    /// metric registration is enforced. Today it is free-form.
    name: String,
    /// Numeric score. Pass/fail metrics conventionally use 1.0 / 0.0.
    value: f64,
    /// Free-form comment (judge rationale, failure reason, etc.).
    comment: Option<String>,
    /// Origin marker — defaults to `"eval_substrate"` per the
    /// spec convention. Harness writers should pass `"eval_harness"`.
    source: Option<String>,
    /// Who/what produced the score — model id, user, "auto", etc.
    scored_by: Option<String>,
    /// Optional FK into `eval_runs.id`. Accepted today but currently
    /// dropped: `insert_score` does not yet write the column. Tracked
    /// as a follow-up — see PR body.
    #[serde(default)]
    #[allow(dead_code)]
    eval_run_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ScoreResponse {
    id: String,
}

async fn create_score(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScoreRequest>,
) -> impl IntoResponse {
    let span = tracing::info_span!(
        "eval.score",
        target_type = %req.target_type,
        name = %req.name,
        source = %req.source.as_deref().unwrap_or("eval_substrate"),
    );
    let _enter = span.enter();

    if req.target_id.trim().is_empty() {
        return invalid_request("target_id is required").into_response();
    }
    if req.name.trim().is_empty() {
        return invalid_request("name is required").into_response();
    }
    if !req.value.is_finite() {
        return invalid_request("value must be finite").into_response();
    }

    let score = gctrl_core::Score {
        id: req.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        target_type: req.target_type,
        target_id: req.target_id,
        name: req.name,
        value: req.value,
        comment: req.comment,
        source: req.source.unwrap_or_else(|| "eval_substrate".into()),
        scored_by: req.scored_by,
        created_at: chrono::Utc::now(),
    };

    match state.store.insert_score(&score) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(ScoreResponse { id: score.id }),
        )
            .into_response(),
        Err(e) => storage_error(e).into_response(),
    }
}

// ---------------------------------------------------------------------------
// /metrics — stubbed until storage accessors land.
// ---------------------------------------------------------------------------

async fn list_metrics() -> impl IntoResponse {
    not_implemented("list_metrics", "eval_metrics accessor pending in gctrl-storage")
}

async fn create_metric(Json(_): Json<serde_json::Value>) -> impl IntoResponse {
    not_implemented(
        "create_metric",
        "eval_metrics insert accessor pending in gctrl-storage",
    )
}

// ---------------------------------------------------------------------------
// /datasets — stubbed until storage accessors land.
// ---------------------------------------------------------------------------

async fn list_datasets() -> impl IntoResponse {
    not_implemented("list_datasets", "eval_datasets accessor pending in gctrl-storage")
}

async fn create_dataset(Json(_): Json<serde_json::Value>) -> impl IntoResponse {
    not_implemented(
        "create_dataset",
        "eval_datasets insert accessor pending in gctrl-storage",
    )
}

// ---------------------------------------------------------------------------
// /cases — stubbed until storage accessors land.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CaseListQuery {
    #[allow(dead_code)]
    dataset_id: Option<String>,
}

async fn list_cases(Query(_): Query<CaseListQuery>) -> impl IntoResponse {
    not_implemented("list_cases", "eval_cases accessor pending in gctrl-storage")
}

async fn create_case(Json(_): Json<serde_json::Value>) -> impl IntoResponse {
    not_implemented(
        "create_case",
        "eval_cases insert accessor pending in gctrl-storage",
    )
}

// ---------------------------------------------------------------------------
// /runs — stubbed until storage accessors land.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RunListQuery {
    #[allow(dead_code)]
    suite_name: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
}

async fn list_runs(Query(_): Query<RunListQuery>) -> impl IntoResponse {
    not_implemented("list_runs", "eval_runs accessor pending in gctrl-storage")
}

async fn create_run(Json(_): Json<serde_json::Value>) -> impl IntoResponse {
    not_implemented(
        "create_run",
        "eval_runs insert accessor pending in gctrl-storage",
    )
}

// ---------------------------------------------------------------------------
// Error envelopes — mirror browser_routes shape: { error, message }.
// ---------------------------------------------------------------------------

fn invalid_request(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid_request", "message": msg })),
    )
}

fn not_implemented(op: &str, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "not_implemented",
            "op": op,
            "message": msg,
        })),
    )
}

fn storage_error(e: gctrl_core::GctlError) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "error": "storage_error",
            "message": e.to_string(),
        })),
    )
}

/// Build the `/api/eval/*` sub-router. Mounted by `receiver::build_router`
/// before `.with_state(state)` so the score handler can resolve
/// `State<Arc<AppState>>`.
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/eval/score", post(create_score))
        .route("/api/eval/metrics", get(list_metrics).post(create_metric))
        .route("/api/eval/datasets", get(list_datasets).post(create_dataset))
        .route("/api/eval/cases", get(list_cases).post(create_case))
        .route("/api/eval/runs", get(list_runs).post(create_run))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn app() -> Router {
        // Bootstrap a minimal in-memory AppState that exercises the score
        // path. The other resources are 501 stubs and don't touch state,
        // but the score path requires a real DuckDbStore.
        let store = Arc::new(
            gctrl_storage::DuckDbStore::open(":memory:").expect("duckdb in-memory"),
        );
        let sqlite = Arc::new(
            gctrl_storage::SqliteStore::open(":memory:").expect("sqlite in-memory"),
        );
        let llm_capture = Arc::new(gctrl_proxy::Capture::new(
            Arc::clone(&store),
            gctrl_proxy::CaptureConfig {
                kernel_otlp_url: "http://127.0.0.1:0/v1/traces".to_string(),
                default_service_name: "test".to_string(),
            },
        ));
        let state = Arc::new(AppState {
            store,
            sqlite,
            context: None,
            started_at: std::time::Instant::now(),
            sync_config: None,
            net_config: Arc::new(gctrl_core::NetConfig::default()),
            http_client: reqwest::Client::new(),
            event_bus: crate::event_bus::EventBus::default_capacity(),
            llm_capture,
            vault_root: None,
            state_dir: std::env::temp_dir(),
        });
        router().with_state(state)
    }

    #[tokio::test]
    async fn score_post_inserts_into_scores() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/eval/score")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"target_type":"eval_case","target_id":"case-1","name":"faithfulness","value":1.0}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["id"].is_string(), "response should carry the score id");
    }

    #[tokio::test]
    async fn score_post_rejects_missing_target_id() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/eval/score")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"target_type":"eval_case","target_id":"","name":"x","value":1.0}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["error"], "invalid_request");
    }

    #[tokio::test]
    async fn score_post_rejects_non_finite_value() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/eval/score")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"target_type":"eval_case","target_id":"x","name":"y","value":null}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        // `null` fails serde deserialization for `f64`; axum's JSON
        // extractor rejects it with 422 Unprocessable Entity. The route
        // would surface a 400 for *parsed* non-finite values (Inf/NaN can
        // appear if the client sends them as a number literal, which JSON
        // technically forbids). Either is a refusal — assert it's a 4xx.
        assert!(resp.status().is_client_error(), "expected 4xx, got {}", resp.status());
    }

    #[tokio::test]
    async fn metrics_get_returns_501_envelope() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/eval/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["error"], "not_implemented");
        assert_eq!(v["op"], "list_metrics");
    }

    #[tokio::test]
    async fn datasets_post_returns_501_envelope() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/eval/datasets")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"smoke"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn cases_get_accepts_dataset_filter() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/eval/cases?dataset_id=ds-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn runs_get_accepts_filters() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .uri("/api/eval/runs?suite_name=core&status=open")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
