use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gctl_context::ContextManager;
use gctl_storage::DuckDbStore;
use serde::Deserialize;

use crate::span_processor::{self, OtlpExportRequest};

pub struct AppState {
    pub store: DuckDbStore,
    pub context: Option<ContextManager>,
    pub started_at: std::time::Instant,
}

pub fn create_router(store: DuckDbStore) -> Router {
    create_router_with_context(store, None)
}

pub fn create_router_with_context(store: DuckDbStore, context: Option<ContextManager>) -> Router {
    let state = Arc::new(AppState { store, context, started_at: std::time::Instant::now() });
    Router::new()
        // OTel ingestion
        .route("/v1/traces", post(ingest_traces))
        // Query endpoints
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{session_id}", get(get_session))
        .route("/api/sessions/{session_id}/spans", get(get_spans))
        .route("/api/analytics", get(get_analytics))
        .route("/api/analytics/cost", get(analytics_cost))
        .route("/api/analytics/latency", get(analytics_latency))
        .route("/api/analytics/spans", get(analytics_spans))
        .route("/api/analytics/scores", get(analytics_scores))
        .route("/api/analytics/daily", get(analytics_daily))
        .route("/api/analytics/score", post(create_score))
        .route("/api/analytics/tag", post(create_tag))
        .route("/api/analytics/alerts", get(list_alerts))
        // Trace tree (Langfuse-style)
        .route("/api/sessions/{session_id}/tree", get(get_trace_tree))
        // Auto-score and session lifecycle
        .route("/api/sessions/{session_id}/auto-score", post(auto_score_session))
        .route("/api/sessions/{session_id}/end", post(end_session))
        .route("/api/sessions/{session_id}/loops", get(detect_loops))
        .route("/api/sessions/{session_id}/cost-breakdown", get(session_cost_breakdown))
        // Context management
        .route("/api/context", get(context_list).post(context_upsert))
        .route("/api/context/compact", get(context_compact))
        .route("/api/context/stats", get(context_stats))
        .route("/api/context/{id}", get(context_get).delete(context_delete))
        .route("/api/context/{id}/content", get(context_content))
        // Board application
        .route("/api/board/projects", get(board_list_projects).post(board_create_project))
        .route("/api/board/issues", get(board_list_issues).post(board_create_issue))
        .route("/api/board/issues/{id}", get(board_get_issue))
        .route("/api/board/issues/{id}/move", post(board_move_issue))
        .route("/api/board/issues/{id}/assign", post(board_assign_issue))
        .route("/api/board/issues/{id}/comment", post(board_add_comment))
        .route("/api/board/issues/{id}/events", get(board_list_events))
        .route("/api/board/issues/{id}/comments", get(board_list_comments))
        .route("/api/board/issues/{id}/link-session", post(board_link_session))
        // Health
        .route("/health", get(health))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let storage = state.store.get_health_info().unwrap_or(serde_json::json!({}));
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "storage": storage,
    }))
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(default = "default_limit")]
    limit: usize,
    agent: Option<String>,
    status: Option<String>,
}

fn default_limit() -> usize {
    20
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> impl IntoResponse {
    match state.store.list_sessions_filtered(params.limit, params.agent.as_deref(), params.status.as_deref()) {
        Ok(sessions) => Json(serde_json::to_value(&sessions).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session(&gctl_core::SessionId(session_id.clone())) {
        Ok(Some(session)) => Json(serde_json::to_value(&session).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("session {session_id} not found")).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_spans(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.query_spans(&gctl_core::SessionId(session_id)) {
        Ok(spans) => Json(serde_json::to_value(&spans).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_trace_tree(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sid = gctl_core::SessionId(session_id.clone());
    let session = match state.store.get_session(&sid) {
        Ok(Some(s)) => s,
        Ok(None) => return (StatusCode::NOT_FOUND, format!("session {session_id} not found")).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let spans = match state.store.query_spans(&sid) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let scores = state.store.get_scores("session", &session_id).unwrap_or_default();
    let tags = state.store.get_tags("session", &session_id).unwrap_or_default();

    // Build tree: root spans (no parent) with children nested
    let root_spans: Vec<&gctl_core::Span> = spans.iter()
        .filter(|s| s.parent_span_id.is_none())
        .collect();

    let build_node = |span: &gctl_core::Span| -> serde_json::Value {
        let children: Vec<serde_json::Value> = spans.iter()
            .filter(|s| s.parent_span_id.as_ref().map(|p| &p.0) == Some(&span.span_id.0))
            .map(|child| {
                serde_json::json!({
                    "span_id": child.span_id.0,
                    "type": child.span_type.as_str(),
                    "operation": child.operation_name,
                    "model": child.model,
                    "input_tokens": child.input_tokens,
                    "output_tokens": child.output_tokens,
                    "cost_usd": child.cost_usd,
                    "duration_ms": child.duration_ms,
                    "status": child.status.as_str(),
                })
            })
            .collect();

        serde_json::json!({
            "span_id": span.span_id.0,
            "type": span.span_type.as_str(),
            "operation": span.operation_name,
            "model": span.model,
            "input_tokens": span.input_tokens,
            "output_tokens": span.output_tokens,
            "cost_usd": span.cost_usd,
            "duration_ms": span.duration_ms,
            "status": span.status.as_str(),
            "children": children,
        })
    };

    let tree: Vec<serde_json::Value> = root_spans.iter().map(|s| build_node(s)).collect();

    Json(serde_json::json!({
        "session": {
            "id": session.id.0,
            "agent_name": session.agent_name,
            "status": session.status.as_str(),
            "total_cost_usd": session.total_cost_usd,
            "total_input_tokens": session.total_input_tokens,
            "total_output_tokens": session.total_output_tokens,
            "started_at": session.started_at.to_rfc3339(),
        },
        "spans": tree,
        "span_count": spans.len(),
        "scores": scores.iter().map(|s| serde_json::json!({"name": s.name, "value": s.value, "source": s.source})).collect::<Vec<_>>(),
        "tags": tags.iter().map(|t| serde_json::json!({"key": t.key, "value": t.value})).collect::<Vec<_>>(),
    })).into_response()
}

async fn auto_score_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.auto_score_session(&session_id) {
        Ok(scores) => (StatusCode::OK, Json(serde_json::to_value(&scores).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn end_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let status = payload["status"].as_str().unwrap_or("completed");
    match state.store.end_session(&session_id, status) {
        Ok(()) => {
            // Auto-score on session end
            let _ = state.store.auto_score_session(&session_id);
            // Check for error loops
            let loops = state.store.detect_error_loops(&session_id, 3).unwrap_or_default();
            if !loops.is_empty() {
                // Create a loop detection score
                let loop_score = gctl_core::Score {
                    id: format!("auto-{session_id}-error_loops"),
                    target_type: "session".into(),
                    target_id: session_id.clone(),
                    name: "error_loops".into(),
                    value: loops.len() as f64,
                    comment: Some(loops.join("; ")),
                    source: "auto".into(),
                    scored_by: None,
                    created_at: chrono::Utc::now(),
                };
                let _ = state.store.insert_score(&loop_score);
            }
            // Compute daily aggregates for today
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let _ = state.store.compute_daily_aggregates(&today);

            Json(serde_json::json!({
                "session_id": session_id,
                "status": status,
                "loops_detected": loops.len(),
            })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn detect_loops(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.detect_error_loops(&session_id, 3) {
        Ok(loops) => Json(serde_json::json!({
            "session_id": session_id,
            "loops": loops,
            "count": loops.len(),
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn session_cost_breakdown(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session_cost_breakdown(&session_id) {
        Ok(breakdown) => Json(serde_json::json!({
            "session_id": session_id,
            "breakdown": breakdown.iter().map(|(m, c, i, o, n)| serde_json::json!({
                "model": m, "cost_usd": c, "input_tokens": i, "output_tokens": o, "span_count": n
            })).collect::<Vec<_>>(),
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_analytics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.get_analytics() {
        Ok(analytics) => Json(serde_json::to_value(&analytics).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn analytics_cost(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cost_by_model = state.store.get_cost_by_model().unwrap_or_default();
    let cost_by_agent = state.store.get_cost_by_agent().unwrap_or_default();
    Json(serde_json::json!({
        "by_model": cost_by_model.iter().map(|(m, c, n)| serde_json::json!({"model": m, "cost": c, "calls": n})).collect::<Vec<_>>(),
        "by_agent": cost_by_agent.iter().map(|(a, c, n)| serde_json::json!({"agent": a, "cost": c, "sessions": n})).collect::<Vec<_>>(),
    })).into_response()
}

async fn analytics_latency(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let latencies = state.store.get_latency_by_model().unwrap_or_default();
    Json(serde_json::json!({
        "by_model": latencies.iter().map(|(m, p50, p95, p99)| serde_json::json!({"model": m, "p50_ms": p50, "p95_ms": p95, "p99_ms": p99})).collect::<Vec<_>>(),
    })).into_response()
}

async fn analytics_spans(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let dist = state.store.get_span_type_distribution().unwrap_or_default();
    Json(serde_json::json!({
        "distribution": dist.iter().map(|(t, c, p)| serde_json::json!({"type": t, "count": c, "percentage": p})).collect::<Vec<_>>(),
    })).into_response()
}

#[derive(Deserialize)]
struct ScoreQueryParams {
    name: String,
}

async fn analytics_scores(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ScoreQueryParams>,
) -> impl IntoResponse {
    match state.store.get_score_summary(&params.name) {
        Ok((pass, fail, avg)) => Json(serde_json::json!({
            "name": params.name,
            "pass": pass,
            "fail": fail,
            "total": pass + fail,
            "pass_rate": if pass + fail > 0 { pass as f64 / (pass + fail) as f64 } else { 0.0 },
            "avg_value": avg,
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct DailyParams {
    #[serde(default = "default_days")]
    days: u32,
}

fn default_days() -> u32 {
    7
}

async fn analytics_daily(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DailyParams>,
) -> impl IntoResponse {
    match state.store.get_daily_aggregates(params.days) {
        Ok(aggs) => Json(serde_json::to_value(&aggs).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn create_score(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let score = gctl_core::Score {
        id: payload["id"].as_str().unwrap_or(&uuid::Uuid::new_v4().to_string()).to_string(),
        target_type: payload["target_type"].as_str().unwrap_or("session").to_string(),
        target_id: payload["target_id"].as_str().unwrap_or("").to_string(),
        name: payload["name"].as_str().unwrap_or("").to_string(),
        value: payload["value"].as_f64().unwrap_or(0.0),
        comment: payload["comment"].as_str().map(String::from),
        source: payload["source"].as_str().unwrap_or("human").to_string(),
        scored_by: payload["scored_by"].as_str().map(String::from),
        created_at: chrono::Utc::now(),
    };
    match state.store.insert_score(&score) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::json!({"id": score.id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn create_tag(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let tag = gctl_core::Tag {
        id: payload["id"].as_str().unwrap_or(&uuid::Uuid::new_v4().to_string()).to_string(),
        target_type: payload["target_type"].as_str().unwrap_or("session").to_string(),
        target_id: payload["target_id"].as_str().unwrap_or("").to_string(),
        key: payload["key"].as_str().unwrap_or("").to_string(),
        value: payload["value"].as_str().unwrap_or("").to_string(),
    };
    match state.store.insert_tag(&tag) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::json!({"id": tag.id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn list_alerts(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Query alert_events from DuckDB
    // For now, just return the rules since we don't have a list_alert_events method yet
    match state.store.list_alert_rules() {
        Ok(rules) => Json(serde_json::to_value(&rules).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn ingest_traces(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OtlpExportRequest>,
) -> impl IntoResponse {
    let spans = span_processor::process_export_request(&payload);

    if spans.is_empty() {
        return StatusCode::OK;
    }

    // Auto-create sessions for new session IDs
    let mut seen_sessions = std::collections::HashSet::new();
    for span in &spans {
        if seen_sessions.insert(span.session_id.0.clone()) {
            if state.store.get_session(&span.session_id).unwrap_or(None).is_none() {
                let session = gctl_core::Session {
                    id: span.session_id.clone(),
                    workspace_id: gctl_core::WorkspaceId("default".into()),
                    device_id: gctl_core::DeviceId("local".into()),
                    agent_name: span.agent_name.clone(),
                    started_at: span.started_at,
                    ended_at: None,
                    status: gctl_core::SessionStatus::Active,
                    total_cost_usd: 0.0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                };
                let _ = state.store.insert_session(&session);
            }
        }
    }

    match state.store.insert_spans(&spans) {
        Ok(()) => {
            tracing::info!(count = spans.len(), "ingested spans");

            // Check alert rules
            if let Ok(rules) = state.store.list_alert_rules() {
                for session_id_str in &seen_sessions {
                    if let Ok(Some(session)) = state.store.get_session(&gctl_core::SessionId(session_id_str.clone())) {
                        for rule in &rules {
                            let should_fire = match rule.condition_type.as_str() {
                                "session_cost" => session.total_cost_usd > rule.threshold,
                                _ => false,
                            };
                            if should_fire {
                                let alert = gctl_core::AlertEvent {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    rule_id: rule.id.clone(),
                                    session_id: Some(session_id_str.clone()),
                                    timestamp: chrono::Utc::now(),
                                    message: format!(
                                        "[{}] {}: session {} cost ${:.2} exceeds threshold ${:.2}",
                                        rule.action, rule.name, session_id_str, session.total_cost_usd, rule.threshold
                                    ),
                                    acknowledged: false,
                                };
                                let _ = state.store.insert_alert_event(&alert);
                                tracing::warn!(
                                    rule = %rule.name,
                                    session = %session_id_str,
                                    cost = session.total_cost_usd,
                                    threshold = rule.threshold,
                                    "alert fired"
                                );
                            }
                        }
                    }
                }
            }

            StatusCode::OK
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to store spans");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

// --- Context Management Handlers ---

#[derive(Deserialize)]
struct ContextListParams {
    kind: Option<String>,
    tag: Option<String>,
    source: Option<String>,
    search: Option<String>,
    #[serde(default = "default_context_limit")]
    limit: usize,
}

fn default_context_limit() -> usize {
    100
}

async fn context_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ContextListParams>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    let filter = gctl_core::context::ContextFilter {
        kind: params.kind.as_deref().and_then(gctl_core::context::ContextKind::from_str),
        tag: params.tag,
        source: params.source,
        search: params.search,
        limit: Some(params.limit),
    };
    match ctx.list(&filter) {
        Ok(entries) => Json(serde_json::to_value(&entries).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ContextUpsertBody {
    path: String,
    title: String,
    content: String,
    #[serde(default = "default_context_kind")]
    kind: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_context_source")]
    source_type: String,
    source_ref: Option<String>,
}

fn default_context_kind() -> String { "document".into() }
fn default_context_source() -> String { "human".into() }

async fn context_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ContextUpsertBody>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    let kind = match gctl_core::context::ContextKind::from_str(&body.kind) {
        Some(k) => k,
        None => return (StatusCode::BAD_REQUEST, format!("invalid kind: {}", body.kind)).into_response(),
    };
    let source = gctl_core::context::ContextSource::from_parts(&body.source_type, body.source_ref.as_deref());
    match ctx.upsert(&kind, &body.path, &body.title, &body.content, &source, &body.tags) {
        Ok(entry) => (StatusCode::CREATED, Json(serde_json::to_value(&entry).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn context_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    match ctx.get(&id).or_else(|_| ctx.get_by_path(&id)) {
        Ok(entry) => Json(serde_json::to_value(&entry).unwrap()).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
    }
}

async fn context_content(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    match ctx.read_content(&id).or_else(|_| ctx.read_content_by_path(&id)) {
        Ok(content) => content.into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
    }
}

async fn context_delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    match ctx.remove(&id).or_else(|_| ctx.remove_by_path(&id)) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
    }
}

#[derive(Deserialize)]
struct ContextCompactParams {
    kind: Option<String>,
    tag: Option<String>,
}

async fn context_compact(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ContextCompactParams>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    let filter = gctl_core::context::ContextFilter {
        kind: params.kind.as_deref().and_then(gctl_core::context::ContextKind::from_str),
        tag: params.tag,
        ..Default::default()
    };
    match ctx.compact(&filter) {
        Ok(compact) => compact.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn context_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (StatusCode::SERVICE_UNAVAILABLE, "context manager not initialized").into_response();
    };
    match ctx.stats() {
        Ok(stats) => Json(serde_json::to_value(&stats).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// --- Board Handlers ---

#[derive(Deserialize)]
struct BoardCreateProjectBody {
    name: String,
    key: String,
}

async fn board_create_project(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BoardCreateProjectBody>,
) -> impl IntoResponse {
    let project = gctl_core::BoardProject {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name,
        key: body.key,
        counter: 0,
    };
    match state.store.create_board_project(&project) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::to_value(&project).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_list_projects(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.list_board_projects() {
        Ok(projects) => Json(serde_json::to_value(&projects).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardCreateIssueBody {
    project_id: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_priority")]
    priority: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    parent_id: Option<String>,
    created_by_id: String,
    created_by_name: String,
    #[serde(default = "default_human")]
    created_by_type: String,
}

fn default_priority() -> String { "none".into() }
fn default_human() -> String { "human".into() }

async fn board_create_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BoardCreateIssueBody>,
) -> impl IntoResponse {
    // Auto-generate ID from project key + counter
    let counter = match state.store.increment_project_counter(&body.project_id) {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("project not found: {}", e)).into_response(),
    };
    let project = match state.store.get_board_project(&body.project_id) {
        Ok(Some(p)) => p,
        _ => return (StatusCode::BAD_REQUEST, "project not found".to_string()).into_response(),
    };

    let now = chrono::Utc::now();
    let issue = gctl_core::BoardIssue {
        id: format!("{}-{}", project.key, counter),
        project_id: body.project_id,
        title: body.title,
        description: body.description,
        status: gctl_core::IssueStatus::Backlog,
        priority: body.priority,
        assignee_id: None,
        assignee_name: None,
        assignee_type: None,
        labels: body.labels,
        parent_id: body.parent_id,
        created_at: now,
        updated_at: now,
        created_by_id: body.created_by_id,
        created_by_name: body.created_by_name,
        created_by_type: body.created_by_type,
        blocked_by: vec![],
        blocking: vec![],
        session_ids: vec![],
        total_cost_usd: 0.0,
        total_tokens: 0,
        pr_numbers: vec![],
    };

    match state.store.insert_board_issue(&issue) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::to_value(&issue).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardIssueListParams {
    project_id: Option<String>,
    status: Option<String>,
    assignee_id: Option<String>,
    label: Option<String>,
    #[serde(default = "default_issue_limit")]
    limit: usize,
}

fn default_issue_limit() -> usize { 50 }

async fn board_list_issues(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BoardIssueListParams>,
) -> impl IntoResponse {
    let filter = gctl_core::BoardIssueFilter {
        project_id: params.project_id,
        status: params.status,
        assignee_id: params.assignee_id,
        label: params.label,
        limit: Some(params.limit),
    };
    match state.store.list_board_issues(&filter) {
        Ok(issues) => Json(serde_json::to_value(&issues).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_get_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_board_issue(&id) {
        Ok(Some(issue)) => Json(serde_json::to_value(&issue).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("issue not found: {}", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardMoveBody {
    status: String,
    actor_id: String,
    actor_name: String,
    #[serde(default = "default_human")]
    actor_type: String,
}

async fn board_move_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardMoveBody>,
) -> impl IntoResponse {
    match state.store.update_board_issue_status(&id, &body.status, &body.actor_id, &body.actor_name, &body.actor_type) {
        Ok(()) => {
            match state.store.get_board_issue(&id) {
                Ok(Some(issue)) => Json(serde_json::to_value(&issue).unwrap()).into_response(),
                _ => StatusCode::OK.into_response(),
            }
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("invalid transition") {
                (StatusCode::UNPROCESSABLE_ENTITY, msg).into_response()
            } else if msg.contains("not found") {
                (StatusCode::NOT_FOUND, msg).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

#[derive(Deserialize)]
struct BoardAssignBody {
    assignee_id: String,
    assignee_name: String,
    #[serde(default = "default_human")]
    assignee_type: String,
}

async fn board_assign_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardAssignBody>,
) -> impl IntoResponse {
    match state.store.assign_board_issue(&id, &body.assignee_id, &body.assignee_name, &body.assignee_type) {
        Ok(()) => {
            match state.store.get_board_issue(&id) {
                Ok(Some(issue)) => Json(serde_json::to_value(&issue).unwrap()).into_response(),
                _ => StatusCode::OK.into_response(),
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardCommentBody {
    author_id: String,
    author_name: String,
    #[serde(default = "default_human")]
    author_type: String,
    body: String,
    #[serde(default)]
    session_id: Option<String>,
}

async fn board_add_comment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardCommentBody>,
) -> impl IntoResponse {
    let comment = gctl_core::BoardComment {
        id: uuid::Uuid::new_v4().to_string(),
        issue_id: id,
        author_id: body.author_id,
        author_name: body.author_name,
        author_type: body.author_type,
        body: body.body,
        created_at: chrono::Utc::now(),
        session_id: body.session_id,
    };
    match state.store.insert_board_comment(&comment) {
        Ok(()) => (StatusCode::CREATED, Json(serde_json::to_value(&comment).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_list_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.list_board_events(&id) {
        Ok(events) => Json(serde_json::to_value(&events).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_list_comments(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.list_board_comments(&id) {
        Ok(comments) => Json(serde_json::to_value(&comments).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardLinkSessionBody {
    session_id: String,
    #[serde(default)]
    cost_usd: f64,
    #[serde(default)]
    tokens: u64,
}

async fn board_link_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardLinkSessionBody>,
) -> impl IntoResponse {
    match state.store.link_session_to_issue(&id, &body.session_id, body.cost_usd, body.tokens) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app() -> Router {
        let store = DuckDbStore::open(":memory:").unwrap();
        create_router(store)
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let app = test_app();
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_list_sessions_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/sessions")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_session_not_found() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/sessions/nonexistent")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_ingest_then_query() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let app = create_router(store);

        // Ingest spans
        let body = serde_json::json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        {"key": "session.id", "value": {"stringValue": "test-session"}},
                        {"key": "service.name", "value": {"stringValue": "test-agent"}}
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "abc123",
                        "spanId": "def456",
                        "name": "llm.call",
                        "startTimeUnixNano": 1700000000000000000_u64,
                        "endTimeUnixNano": 1700000002000000000_u64,
                        "attributes": [
                            {"key": "ai.model.id", "value": {"stringValue": "claude-opus-4-6"}},
                            {"key": "ai.tokens.input", "value": {"intValue": 500}},
                            {"key": "ai.tokens.output", "value": {"intValue": 200}}
                        ],
                        "status": {"code": 1}
                    }]
                }]
            }]
        });

        let req = Request::builder()
            .method("POST")
            .uri("/v1/traces")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Query sessions
        let req = Request::builder()
            .uri("/api/sessions")
            .body(Body::empty())
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let sessions: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        assert_eq!(sessions[0]["agent_name"], "test-agent");

        // Query spans
        let req = Request::builder()
            .uri("/api/sessions/test-session/spans")
            .body(Body::empty())
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let spans: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(spans.as_array().unwrap().len(), 1);
        assert_eq!(spans[0]["operation_name"], "llm.call");
        assert_eq!(spans[0]["input_tokens"], 500);

        // Query analytics
        let req = Request::builder()
            .uri("/api/analytics")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let analytics: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(analytics["total_sessions"], 1);
        assert_eq!(analytics["total_spans"], 1);
    }

    #[tokio::test]
    async fn test_ingest_traces_empty() {
        let app = test_app();
        let body = serde_json::json!({"resourceSpans": []});
        let req = Request::builder()
            .method("POST")
            .uri("/v1/traces")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_analytics_cost_empty() {
        let app = test_app();
        let req = Request::builder().uri("/api/analytics/cost").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["by_model"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_analytics_latency_empty() {
        let app = test_app();
        let req = Request::builder().uri("/api/analytics/latency").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_create_score() {
        let app = test_app();
        let body = serde_json::json!({
            "target_type": "session",
            "target_id": "s1",
            "name": "quality",
            "value": 4.5
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/analytics/score")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_create_tag() {
        let app = test_app();
        let body = serde_json::json!({
            "target_type": "session",
            "target_id": "s1",
            "key": "project",
            "value": "api-server"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/analytics/tag")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_analytics_spans_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/analytics/spans")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["distribution"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_analytics_scores_query() {
        let store = DuckDbStore::open(":memory:").unwrap();
        // Insert a score directly
        store.insert_score(&gctl_core::Score {
            id: "s1".into(),
            target_type: "session".into(),
            target_id: "sess1".into(),
            name: "tests_pass".into(),
            value: 1.0,
            comment: None,
            source: "auto".into(),
            scored_by: None,
            created_at: chrono::Utc::now(),
        }).unwrap();

        let app = create_router(store);
        let req = Request::builder()
            .uri("/api/analytics/scores?name=tests_pass")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["pass"], 1);
        assert_eq!(json["total"], 1);
    }

    #[tokio::test]
    async fn test_health_detailed() {
        let app = test_app();
        let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok");
        assert!(json["version"].is_string());
        assert!(json["uptime_seconds"].is_number());
        assert!(json["storage"]["sessions"].is_number());
    }

    #[tokio::test]
    async fn test_session_cost_breakdown_endpoint() {
        let store = DuckDbStore::open(":memory:").unwrap();
        store.insert_session(&gctl_core::Session {
            id: gctl_core::SessionId("s1".into()),
            workspace_id: gctl_core::WorkspaceId("ws1".into()),
            device_id: gctl_core::DeviceId("dev1".into()),
            agent_name: "claude".into(),
            started_at: chrono::Utc::now(),
            ended_at: None,
            status: gctl_core::SessionStatus::Active,
            total_cost_usd: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
        }).unwrap();

        let app = create_router(store);
        let req = Request::builder()
            .uri("/api/sessions/s1/cost-breakdown")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["session_id"], "s1");
        assert!(json["breakdown"].is_array());
    }
}
