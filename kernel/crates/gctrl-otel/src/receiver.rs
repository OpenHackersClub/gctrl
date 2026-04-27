use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, patch, post},
    Json, Router,
};
use async_stream::stream;
use futures_core::Stream;
use gctrl_context::ContextManager;
use gctrl_core::{NetConfig, SyncConfig};
use gctrl_storage::{DuckDbStore, SqliteStore};
use serde::Deserialize;

use crate::event_bus::{EventBus, ReplayResult, SessionEvent};
use crate::span_processor::{self, OtlpExportRequest};

pub struct AppState {
    pub store: Arc<DuckDbStore>,
    pub sqlite: Arc<SqliteStore>,
    pub context: Option<ContextManager>,
    pub started_at: std::time::Instant,
    /// D1 sync credentials. None disables the `/api/sync/push` endpoint.
    pub sync_config: Option<Arc<SyncConfig>>,
    /// External driver credentials (Brave Search, Cloudflare Browser Rendering).
    pub net_config: Arc<NetConfig>,
    /// Shared HTTP client used by external drivers (Brave, CF Browser) so each
    /// request reuses the connection pool instead of rebuilding it.
    pub http_client: reqwest::Client,
    /// Live session-event bus (broadcast + replay ring) consumed by the
    /// SSE stream handlers — see spec/architecture/apps/gctrl-analytics.md §5.
    pub event_bus: Arc<EventBus>,
}

pub fn create_router(store: DuckDbStore) -> Router {
    create_router_with_context(store, None)
}

/// Create router from a pre-shared Arc<DuckDbStore> (used when store is shared with other tasks).
pub fn create_router_from_arc(store: Arc<DuckDbStore>) -> Router {
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite open"));
    let state = Arc::new(AppState {
        store: Arc::clone(&store),
        sqlite,
        context: None,
        started_at: std::time::Instant::now(),
        sync_config: None,
        net_config: Arc::new(NetConfig::default()),
        http_client: reqwest::Client::new(),
        event_bus: EventBus::default_capacity(),
    });
    build_router(state)
}

/// Create router with both DuckDB (OTel) and SQLite (board/inbox/persona) stores.
pub fn create_router_dual(store: Arc<DuckDbStore>, sqlite: Arc<SqliteStore>) -> Router {
    create_router_dual_with_sync(store, sqlite, None)
}

/// Create router with dual stores and an optional D1 sync config that gates
/// the `/api/sync/push` endpoint.
pub fn create_router_dual_with_sync(
    store: Arc<DuckDbStore>,
    sqlite: Arc<SqliteStore>,
    sync_config: Option<Arc<SyncConfig>>,
) -> Router {
    create_router_full(store, sqlite, sync_config, Arc::new(NetConfig::default()))
}

/// Create router with dual stores, D1 sync, and external network drivers (Brave, CF Browser).
///
/// Mounts the scheduler routes (`/api/schedules*`) alongside the main router
/// using a separate state — the scheduler is self-contained and only needs
/// the SQLite store, so it owns its own `with_state` rather than fattening
/// `AppState`.
pub fn create_router_full(
    store: Arc<DuckDbStore>,
    sqlite: Arc<SqliteStore>,
    sync_config: Option<Arc<SyncConfig>>,
    net_config: Arc<NetConfig>,
) -> Router {
    let state = Arc::new(AppState {
        store,
        sqlite: Arc::clone(&sqlite),
        context: None,
        started_at: std::time::Instant::now(),
        sync_config,
        net_config,
        http_client: reqwest::Client::new(),
        event_bus: EventBus::default_capacity(),
    });
    build_router(state).merge(gctrl_scheduler::http::router(sqlite))
}

pub fn create_router_with_context(store: DuckDbStore, context: Option<ContextManager>) -> Router {
    let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite open"));
    let state = Arc::new(AppState {
        store: Arc::new(store),
        sqlite,
        context,
        started_at: std::time::Instant::now(),
        sync_config: None,
        net_config: Arc::new(NetConfig::default()),
        http_client: reqwest::Client::new(),
        event_bus: EventBus::default_capacity(),
    });
    build_router(state)
}

fn build_router(state: Arc<AppState>) -> Router {
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
        .route("/api/contributions", get(list_contributions))
        // Trace tree (Langfuse-style)
        .route("/api/sessions/{session_id}/tree", get(get_trace_tree))
        // SSE live streams — global + per-session (gctrl-analytics §5)
        .route("/api/sessions/stream", get(stream_sessions))
        .route("/api/sessions/{session_id}/stream", get(stream_session))
        // Auto-score and session lifecycle
        .route(
            "/api/sessions/{session_id}/auto-score",
            post(auto_score_session),
        )
        .route("/api/sessions/{session_id}/end", post(end_session))
        .route("/api/sessions/{session_id}/loops", get(detect_loops))
        .route(
            "/api/sessions/{session_id}/cost-breakdown",
            get(session_cost_breakdown),
        )
        // Context management
        .route("/api/context", get(context_list).post(context_upsert))
        .route("/api/context/compact", get(context_compact))
        .route("/api/context/stats", get(context_stats))
        .route("/api/context/{id}", get(context_get).delete(context_delete))
        .route("/api/context/{id}/content", get(context_content))
        // Board application
        .route(
            "/api/board/projects",
            get(board_list_projects).post(board_create_project),
        )
        .route(
            "/api/board/issues",
            get(board_list_issues).post(board_create_issue),
        )
        .route("/api/board/issues/{id}", get(board_get_issue))
        .route("/api/board/issues/{id}/move", post(board_move_issue))
        .route("/api/board/issues/{id}/assign", post(board_assign_issue))
        .route("/api/board/issues/{id}/comment", post(board_add_comment))
        .route("/api/board/issues/{id}/events", get(board_list_events))
        .route("/api/board/issues/{id}/comments", get(board_list_comments))
        .route("/api/board/issues/{id}/link-session", post(board_link_session))
        .route("/api/board/issues/{id}/schedule", patch(board_schedule_issue))
        .route("/api/board/projects/{id}/gantt", get(board_gantt_for_project))
        .route("/api/board/issues/{id}/acceptance", get(board_acceptance_rollup))
        .route(
            "/api/board/issues/{id}/acceptance/checks/{idx}",
            post(board_acceptance_report),
        )
        .route("/api/board/import", post(board_import_markdown))
        .route("/api/board/export", post(board_export_markdown))
        .route("/api/board/projects/{id}/github", post(board_link_github))
        // GitHub driver (LKM — delegates to native `gh` CLI)
        .route(
            "/api/github/issues",
            get(gh_list_issues).post(gh_create_issue),
        )
        .route("/api/github/issues/{number}", get(gh_get_issue))
        .route("/api/github/prs", get(gh_list_prs))
        .route("/api/github/prs/{number}", get(gh_get_pr))
        .route("/api/github/runs", get(gh_list_runs))
        .route("/api/github/runs/{run_id}", get(gh_get_run))
        .route("/api/github/exec", post(gh_exec_passthrough))
        // Wrangler driver (LKM — delegates to native `wrangler` CLI)
        .route("/api/wrangler/whoami", get(wrangler_whoami))
        .route("/api/wrangler/exec", post(wrangler_exec_passthrough))
        // Messaging drivers (LKM — outbound to Telegram Bot API and Discord webhooks)
        .route("/api/telegram/send", post(telegram_send))
        .route("/api/discord/send", post(discord_send))
        // LLM driver (LKM — outbound via Cloudflare AI Gateway)
        // /messages  → Anthropic-shape upstream (Claude models)
        // /completions → Workers AI OpenAI-compat upstream (e.g. @cf/google/gemma-*)
        .route("/api/llm/messages", post(llm_messages))
        .route("/api/llm/completions", post(llm_completions))
        // Search driver (Brave Search API)
        .route("/api/search/web", post(search_web))
        .route("/api/search/news", post(search_news))
        .route("/api/search/images", post(search_images))
        // Net driver (reqwest + Cloudflare Browser Rendering orchestrator)
        .route("/api/net/fetch", post(net_fetch))
        .route("/api/net/render", post(net_render))
        .route("/api/net/scrape", post(net_scrape))
        .route("/api/net/screenshot", post(net_screenshot))
        // Persona management (kernel extension)
        .route("/api/personas", get(persona_list).post(persona_upsert))
        .route("/api/personas/seed", post(persona_seed))
        .route(
            "/api/personas/review-rules",
            get(persona_review_rules_list).post(persona_review_rules_upsert),
        )
        .route(
            "/api/personas/{id}",
            get(persona_get).delete(persona_delete),
        )
        // Team composition
        .route("/api/team/recommend", post(team_recommend))
        .route("/api/team/render", post(team_render))
        // Inbox application
        .route(
            "/api/inbox/messages",
            get(inbox_list_messages).post(inbox_create_message),
        )
        .route("/api/inbox/messages/{id}", get(inbox_get_message))
        .route("/api/inbox/threads", get(inbox_list_threads))
        .route("/api/inbox/threads/{id}", get(inbox_get_thread))
        .route(
            "/api/inbox/actions",
            get(inbox_list_actions).post(inbox_create_action),
        )
        .route("/api/inbox/batch-action", post(inbox_batch_action))
        .route("/api/inbox/stats", get(inbox_stats))
        // Sync (SQLite → D1 push)
        .route("/api/sync/push", post(sync_push))
        // Memory (D1-syncable long-lived knowledge)
        .route("/api/memory", get(memory_list).post(memory_upsert))
        .route("/api/memory/stats", get(memory_stats))
        .route("/api/memory/{id}", get(memory_get).delete(memory_delete))
        // Health
        .route("/health", get(health))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let storage = state
        .store
        .get_health_info()
        .unwrap_or(serde_json::json!({}));
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
    /// Comma-separated provenance values:
    /// `scheduler`, `otel_ingest`, `api`, `unknown`. Unrecognised tokens
    /// are silently ignored so an empty filter doesn't 400 on typos —
    /// we'd rather over-return than under-return on filter sites.
    created_by: Option<String>,
    /// Derived shorthand: `internal` ⇒ {Scheduler, Api},
    /// `external` ⇒ {OtelIngest}. Mutually exclusive with `created_by`;
    /// `created_by` wins if both are present.
    kind: Option<String>,
}

fn default_limit() -> usize {
    20
}

/// Parse `?created_by=scheduler,api` and `?kind=internal|external` into
/// the `CreatedBy` set passed to the storage layer. Returns `None` when
/// no filter is requested (i.e. "all rows"), `Some([])` when the caller
/// passed only unrecognised tokens (matches no rows).
fn parse_created_by_filter(
    raw: Option<&str>,
    kind: Option<&str>,
) -> Option<Vec<gctrl_core::CreatedBy>> {
    if let Some(s) = raw {
        let parsed: Vec<_> = s
            .split(',')
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .filter_map(gctrl_core::CreatedBy::from_str)
            .collect();
        return Some(parsed);
    }
    match kind {
        Some("internal") => Some(vec![
            gctrl_core::CreatedBy::Scheduler,
            gctrl_core::CreatedBy::Api,
        ]),
        Some("external") => Some(vec![gctrl_core::CreatedBy::OtelIngest]),
        _ => None,
    }
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> impl IntoResponse {
    let provenances =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    match state.store.list_sessions_filtered(
        params.limit,
        params.agent.as_deref(),
        params.status.as_deref(),
        provenances.as_deref(),
    ) {
        Ok(sessions) => Json(serde_json::to_value(&sessions).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state
        .store
        .get_session(&gctrl_core::SessionId(session_id.clone()))
    {
        Ok(Some(session)) => Json(serde_json::to_value(&session).unwrap()).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            format!("session {session_id} not found"),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_spans(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.query_spans(&gctrl_core::SessionId(session_id)) {
        Ok(spans) => Json(serde_json::to_value(&spans).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_trace_tree(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sid = gctrl_core::SessionId(session_id.clone());
    let session = match state.store.get_session(&sid) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                format!("session {session_id} not found"),
            )
                .into_response()
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let spans = match state.store.query_spans(&sid) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let scores = state
        .store
        .get_scores("session", &session_id)
        .unwrap_or_default();
    let tags = state
        .store
        .get_tags("session", &session_id)
        .unwrap_or_default();

    // Build tree: root spans (no parent) with children nested
    let root_spans: Vec<&gctrl_core::Span> = spans
        .iter()
        .filter(|s| s.parent_span_id.is_none())
        .collect();

    let build_node = |span: &gctrl_core::Span| -> serde_json::Value {
        let children: Vec<serde_json::Value> = spans
            .iter()
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

// --- SSE: live session stream (M0-final per gctrl-analytics §5) ---

/// Parse the optional `Last-Event-ID` header into a u64. Browser
/// `EventSource` automatically resends this on reconnect; clients can
/// also pass `?last_event_id=N` for environments that don't preserve
/// the header (e.g. some HTTP/2 proxies).
fn parse_last_event_id(headers: &HeaderMap, q: Option<&str>) -> Option<u64> {
    headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .or(q)
        .and_then(|s| s.trim().parse::<u64>().ok())
}

#[derive(Deserialize)]
struct StreamQuery {
    /// Fallback for environments that strip the Last-Event-ID header
    /// across reconnects.
    last_event_id: Option<String>,
}

/// Build an SSE event from one bus entry. The `id:` field is the bus's
/// monotonic counter — the client uses it as `Last-Event-ID` on
/// reconnect.
fn entry_to_sse(id: u64, event: &SessionEvent) -> Result<Event, Infallible> {
    let payload = serde_json::to_string(event).unwrap_or_else(|_| "{}".into());
    Ok(Event::default()
        .id(id.to_string())
        .event(event.event_name())
        .data(payload))
}

/// `GET /api/sessions/stream` — broadcast every session event.
async fn stream_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    sse_response(state, headers, q, None)
}

/// `GET /api/sessions/{session_id}/stream` — events filtered to one
/// session. Same broadcast underneath; we just drop entries that don't
/// match `session_id`.
async fn stream_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    sse_response(state, headers, q, Some(session_id))
}

/// Shared SSE assembly: replay any buffered events past `Last-Event-ID`
/// (emitting `replay_gap` if we can't), then tail the live broadcast.
fn sse_response(
    state: Arc<AppState>,
    headers: HeaderMap,
    q: StreamQuery,
    filter_session: Option<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let last_id = parse_last_event_id(&headers, q.last_event_id.as_deref());
    let mut rx = state.event_bus.subscribe();
    let bus = Arc::clone(&state.event_bus);

    let body = stream! {
        // 1) Replay phase. If the client provided Last-Event-ID, dump
        //    any buffered events newer than that id; otherwise skip.
        if let Some(last) = last_id {
            match bus.replay_after(last) {
                ReplayResult::Events(events) => {
                    for (id, ev) in events {
                        if filter_session.as_deref().is_some_and(|s| s != ev.session_id()) {
                            continue;
                        }
                        yield entry_to_sse(id, &ev);
                    }
                }
                ReplayResult::Gap => {
                    // Client missed events that aged out of the ring.
                    // Tell them to refetch state, then resume tailing.
                    yield Ok(Event::default()
                        .event("replay_gap")
                        .data("{}"));
                }
                ReplayResult::Caught => {}
            }
        }

        // 2) Tail phase. Stream live broadcasts until the client
        //    disconnects or the receiver lags.
        loop {
            match rx.recv().await {
                Ok((id, ev)) => {
                    if filter_session.as_deref().is_some_and(|s| s != ev.session_id()) {
                        continue;
                    }
                    yield entry_to_sse(id, &ev);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Slow consumer — close the connection. Client will
                    // reconnect with Last-Event-ID and replay-or-gap
                    // through the same path.
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Sse::new(body).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}

async fn auto_score_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.store.auto_score_session(&session_id) {
        Ok(scores) => {
            (StatusCode::OK, Json(serde_json::to_value(&scores).unwrap())).into_response()
        }
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
            state.event_bus.publish(SessionEvent::Ended {
                session_id: session_id.clone(),
                status: status.into(),
                ended_at: chrono::Utc::now().to_rfc3339(),
            });
            // Auto-score on session end
            let _ = state.store.auto_score_session(&session_id);
            // Check for error loops
            let loops = state
                .store
                .detect_error_loops(&session_id, 3)
                .unwrap_or_default();
            if !loops.is_empty() {
                // Create a loop detection score
                let loop_score = gctrl_core::Score {
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
            }))
            .into_response()
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
        }))
        .into_response(),
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
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Shared `?kind=` / `?created_by=` query params for the analytics
/// rollup routes. Mirrors `ListParams` so the same provenance vocabulary
/// works on `/api/sessions` and `/api/analytics/*`. See
/// specs/architecture/apps/gctrl-analytics.md §1, M3 follow-up.
#[derive(Deserialize, Default)]
struct AnalyticsParams {
    created_by: Option<String>,
    kind: Option<String>,
}

async fn get_analytics(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AnalyticsParams>,
) -> impl IntoResponse {
    let provenances =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    match state.store.get_analytics(provenances.as_deref()) {
        Ok(analytics) => Json(serde_json::to_value(&analytics).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn analytics_cost(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AnalyticsParams>,
) -> impl IntoResponse {
    let provenances =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    let prov_slice = provenances.as_deref();
    let cost_by_model = state.store.get_cost_by_model(prov_slice).unwrap_or_default();
    let cost_by_agent = state.store.get_cost_by_agent(prov_slice).unwrap_or_default();
    Json(serde_json::json!({
        "by_model": cost_by_model.iter().map(|(m, c, n)| serde_json::json!({"model": m, "cost": c, "calls": n})).collect::<Vec<_>>(),
        "by_agent": cost_by_agent.iter().map(|(a, c, n)| serde_json::json!({"agent": a, "cost": c, "sessions": n})).collect::<Vec<_>>(),
    })).into_response()
}

async fn analytics_latency(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AnalyticsParams>,
) -> impl IntoResponse {
    let provenances =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    let latencies = state
        .store
        .get_latency_by_model(provenances.as_deref())
        .unwrap_or_default();
    Json(serde_json::json!({
        "by_model": latencies.iter().map(|(m, p50, p95, p99)| serde_json::json!({"model": m, "p50_ms": p50, "p95_ms": p95, "p99_ms": p99})).collect::<Vec<_>>(),
    })).into_response()
}

async fn analytics_spans(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AnalyticsParams>,
) -> impl IntoResponse {
    let provenances =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    let dist = state
        .store
        .get_span_type_distribution(provenances.as_deref())
        .unwrap_or_default();
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
        }))
        .into_response(),
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
    let score = gctrl_core::Score {
        id: payload["id"]
            .as_str()
            .unwrap_or(&uuid::Uuid::new_v4().to_string())
            .to_string(),
        target_type: payload["target_type"]
            .as_str()
            .unwrap_or("session")
            .to_string(),
        target_id: payload["target_id"].as_str().unwrap_or("").to_string(),
        name: payload["name"].as_str().unwrap_or("").to_string(),
        value: payload["value"].as_f64().unwrap_or(0.0),
        comment: payload["comment"].as_str().map(String::from),
        source: payload["source"].as_str().unwrap_or("human").to_string(),
        scored_by: payload["scored_by"].as_str().map(String::from),
        created_at: chrono::Utc::now(),
    };
    match state.store.insert_score(&score) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::json!({"id": score.id})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn create_tag(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let tag = gctrl_core::Tag {
        id: payload["id"]
            .as_str()
            .unwrap_or(&uuid::Uuid::new_v4().to_string())
            .to_string(),
        target_type: payload["target_type"]
            .as_str()
            .unwrap_or("session")
            .to_string(),
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

    // Auto-create sessions for new session IDs.
    // `started_emit` collects sessions we created here so we can emit
    // `session.started` events only for genuinely new rows (not for
    // sessions that already existed when the span landed).
    let mut seen_sessions = std::collections::HashSet::new();
    let mut started_emit: Vec<gctrl_core::Session> = Vec::new();
    for span in &spans {
        if seen_sessions.insert(span.session_id.0.clone()) {
            if state
                .store
                .get_session(&span.session_id)
                .unwrap_or(None)
                .is_none()
            {
                let session = gctrl_core::Session {
                    id: span.session_id.clone(),
                    workspace_id: gctrl_core::WorkspaceId("default".into()),
                    device_id: gctrl_core::DeviceId("local".into()),
                    agent_name: span.agent_name.clone(),
                    started_at: span.started_at,
                    ended_at: None,
                    status: gctrl_core::SessionStatus::Active,
                    total_cost_usd: 0.0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                    // Auto-create on OTLP ingest is the canonical
                    // `external` provenance — see analytics spec §1.
                    created_by: gctrl_core::CreatedBy::OtelIngest,
                };
                if state.store.insert_session(&session).is_ok() {
                    started_emit.push(session);
                }
            }
        }
    }

    match state.store.insert_spans(&spans) {
        Ok(()) => {
            tracing::info!(count = spans.len(), "ingested spans");

            // Publish lifecycle + span events on the live bus.
            // Errors here would only mean no live subscribers — the DB
            // write already succeeded, so we silently drop.
            for session in &started_emit {
                state.event_bus.publish(SessionEvent::Started {
                    session_id: session.id.0.clone(),
                    agent_name: session.agent_name.clone(),
                    started_at: session.started_at.to_rfc3339(),
                });
            }
            for span in &spans {
                state.event_bus.publish(SessionEvent::Span {
                    session_id: span.session_id.0.clone(),
                    span_id: span.span_id.0.clone(),
                    parent_span_id: span.parent_span_id.as_ref().map(|p| p.0.clone()),
                    span_type: span.span_type.as_str().into(),
                    operation: span.operation_name.clone(),
                    model: span.model.clone(),
                    cost_usd: span.cost_usd,
                    duration_ms: span.duration_ms,
                    status: span.status.as_str().into(),
                    ts: span.started_at.to_rfc3339(),
                });
            }
            // end live event publish

            // Check alert rules
            if let Ok(rules) = state.store.list_alert_rules() {
                for session_id_str in &seen_sessions {
                    if let Ok(Some(session)) = state
                        .store
                        .get_session(&gctrl_core::SessionId(session_id_str.clone()))
                    {
                        for rule in &rules {
                            let should_fire = match rule.condition_type.as_str() {
                                "session_cost" => session.total_cost_usd > rule.threshold,
                                _ => false,
                            };
                            if should_fire {
                                let alert = gctrl_core::AlertEvent {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    rule_id: rule.id.clone(),
                                    session_id: Some(session_id_str.clone()),
                                    timestamp: chrono::Utc::now(),
                                    message: format!(
                                        "[{}] {}: session {} cost ${:.2} exceeds threshold ${:.2}",
                                        rule.action,
                                        rule.name,
                                        session_id_str,
                                        session.total_cost_usd,
                                        rule.threshold
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
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
    };
    let filter = gctrl_core::context::ContextFilter {
        kind: params
            .kind
            .as_deref()
            .and_then(gctrl_core::context::ContextKind::from_str),
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

fn default_context_kind() -> String {
    "document".into()
}
fn default_context_source() -> String {
    "human".into()
}

async fn context_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ContextUpsertBody>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
    };
    let kind = match gctrl_core::context::ContextKind::from_str(&body.kind) {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid kind: {}", body.kind),
            )
                .into_response()
        }
    };
    let source = gctrl_core::context::ContextSource::from_parts(
        &body.source_type,
        body.source_ref.as_deref(),
    );
    match ctx.upsert(
        &kind,
        &body.path,
        &body.title,
        &body.content,
        &source,
        &body.tags,
    ) {
        Ok(entry) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&entry).unwrap()),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn context_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
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
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
    };
    match ctx
        .read_content(&id)
        .or_else(|_| ctx.read_content_by_path(&id))
    {
        Ok(content) => content.into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
    }
}

async fn context_delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(ref ctx) = state.context else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
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
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
    };
    let filter = gctrl_core::context::ContextFilter {
        kind: params
            .kind
            .as_deref()
            .and_then(gctrl_core::context::ContextKind::from_str),
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
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "context manager not initialized",
        )
            .into_response();
    };
    match ctx.stats() {
        Ok(stats) => Json(serde_json::to_value(&stats).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// --- Memory Handlers ---

#[derive(Deserialize)]
struct MemoryListParams {
    #[serde(rename = "type")]
    memory_type: Option<String>,
    tag: Option<String>,
    search: Option<String>,
    #[serde(default = "default_memory_limit")]
    limit: usize,
}

fn default_memory_limit() -> usize {
    100
}

async fn memory_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MemoryListParams>,
) -> impl IntoResponse {
    let filter = gctrl_core::memory::MemoryFilter {
        memory_type: params
            .memory_type
            .as_deref()
            .and_then(gctrl_core::memory::MemoryType::from_str),
        tag: params.tag,
        search: params.search,
        limit: Some(params.limit),
    };
    match state.sqlite.list_memories(&filter) {
        Ok(entries) => Json(serde_json::to_value(&entries).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct MemoryUpsertBody {
    #[serde(rename = "type")]
    memory_type: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    device_id: String,
    /// Optional — if omitted, we generate a UUID. On conflict with (device_id, name) the
    /// existing id is preserved regardless.
    #[serde(default)]
    id: Option<String>,
}

async fn memory_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MemoryUpsertBody>,
) -> impl IntoResponse {
    let memory_type = match gctrl_core::memory::MemoryType::from_str(&body.memory_type) {
        Some(t) => t,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid type: {}", body.memory_type),
            )
                .into_response()
        }
    };
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if body.device_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "device_id is required").into_response();
    }

    let now = chrono::Utc::now();
    let entry = gctrl_core::memory::MemoryEntry {
        id: gctrl_core::memory::MemoryEntryId(
            body.id
                .unwrap_or_else(|| format!("mem-{}", uuid::Uuid::new_v4())),
        ),
        memory_type,
        name: body.name,
        description: body.description,
        body: body.body,
        tags: body.tags,
        device_id: body.device_id,
        created_at: now,
        updated_at: now,
        synced: false,
    };

    match state.sqlite.upsert_memory(&entry) {
        Ok(_) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&entry).unwrap()),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn memory_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.get_memory(&id) {
        Ok(Some(entry)) => Json(serde_json::to_value(&entry).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn memory_delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.remove_memory(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, format!("not found: {}", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn memory_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.sqlite.get_memory_stats() {
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
    let project = gctrl_core::BoardProject {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name,
        key: body.key,
        counter: 0,
        github_repo: None,
    };
    match state.sqlite.create_board_project(&project) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&project).unwrap()),
        )
            .into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Duplicate key")
                || msg.contains("Constraint Error")
                || msg.contains("UNIQUE constraint failed")
            {
                (
                    StatusCode::CONFLICT,
                    format!("project with key '{}' already exists", project.key),
                )
                    .into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

async fn board_list_projects(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.sqlite.list_board_projects() {
        Ok(projects) => Json(serde_json::to_value(&projects).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardLinkGithubBody {
    github_repo: String,
}

async fn board_link_github(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardLinkGithubBody>,
) -> impl IntoResponse {
    match state
        .sqlite
        .update_board_project_github_repo(&id, &body.github_repo)
    {
        Ok(()) => match state.sqlite.get_board_project(&id) {
            Ok(Some(project)) => Json(serde_json::to_value(&project).unwrap()).into_response(),
            _ => (StatusCode::NOT_FOUND, "project not found".to_string()).into_response(),
        },
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
    #[serde(default)]
    github_issue_number: Option<u32>,
    #[serde(default)]
    github_url: Option<String>,
    #[serde(default)]
    acceptance_criteria: Option<String>,
}

fn default_priority() -> String {
    "none".into()
}
fn default_human() -> String {
    "human".into()
}

async fn board_create_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BoardCreateIssueBody>,
) -> impl IntoResponse {
    // Auto-generate ID from project key + counter
    let counter = match state.sqlite.increment_project_counter(&body.project_id) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("project not found: {}", e)).into_response()
        }
    };
    let project = match state.sqlite.get_board_project(&body.project_id) {
        Ok(Some(p)) => p,
        _ => return (StatusCode::BAD_REQUEST, "project not found".to_string()).into_response(),
    };

    let now = chrono::Utc::now();
    let issue = gctrl_core::BoardIssue {
        id: format!("{}-{}", project.key, counter),
        project_id: body.project_id,
        title: body.title,
        description: body.description,
        status: gctrl_core::IssueStatus::Backlog,
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
        content_hash: None,
        source_path: None,
        github_issue_number: body.github_issue_number,
        github_url: body.github_url,
        start_date: None,
        due_date: None,
        acceptance_criteria: body.acceptance_criteria,
    };

    match state.sqlite.insert_board_issue(&issue) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&issue).unwrap()),
        )
            .into_response(),
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

fn default_issue_limit() -> usize {
    50
}

async fn board_list_issues(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BoardIssueListParams>,
) -> impl IntoResponse {
    let filter = gctrl_core::BoardIssueFilter {
        project_id: params.project_id,
        status: params.status,
        assignee_id: params.assignee_id,
        label: params.label,
        limit: Some(params.limit),
    };
    match state.sqlite.list_board_issues(&filter) {
        Ok(issues) => Json(serde_json::to_value(&issues).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_get_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.get_board_issue(&id) {
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

/// Resolves the agent runtime kind for an Issue at dispatch time.
///
/// TODO(tier2.5): parse `agent.runtime` from `WORKFLOW.md` at the project
/// filesystem root (see vault/specs/architecture/session-trigger-from-board.md
/// §"Agent resolution"). For now we hardcode the default runtime so the HTTP
/// envelope contract is exercised end-to-end.
fn resolve_agent_kind(_project_key: Option<&str>) -> String {
    "claude-code".to_string()
}

async fn board_move_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardMoveBody>,
) -> impl IntoResponse {
    let agent_kind = resolve_agent_kind(None);
    let promoted = state.sqlite.update_board_issue_status_and_promote(
        &id,
        &body.status,
        &agent_kind,
        &body.actor_id,
        &body.actor_name,
        &body.actor_type,
    );
    match promoted {
        Ok(task_opt) => {
            let issue_val = match state.sqlite.get_board_issue(&id) {
                Ok(Some(issue)) => serde_json::to_value(&issue).unwrap_or(serde_json::Value::Null),
                _ => serde_json::Value::Null,
            };
            let (task_id, dispatched) = match task_opt {
                Some(task) => (serde_json::Value::String(task.id), true),
                None => (serde_json::Value::Null, false),
            };
            Json(serde_json::json!({
                "issue": issue_val,
                "task_id": task_id,
                "dispatched": dispatched,
            }))
            .into_response()
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
    match state.sqlite.assign_board_issue(
        &id,
        &body.assignee_id,
        &body.assignee_name,
        &body.assignee_type,
    ) {
        Ok(()) => match state.sqlite.get_board_issue(&id) {
            Ok(Some(issue)) => Json(serde_json::to_value(&issue).unwrap()).into_response(),
            _ => StatusCode::OK.into_response(),
        },
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
    let comment = gctrl_core::BoardComment {
        id: uuid::Uuid::new_v4().to_string(),
        issue_id: id,
        author_id: body.author_id,
        author_name: body.author_name,
        author_type: body.author_type,
        body: body.body,
        created_at: chrono::Utc::now(),
        session_id: body.session_id,
    };
    match state.sqlite.insert_board_comment(&comment) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&comment).unwrap()),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_list_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.list_board_events(&id) {
        Ok(events) => Json(serde_json::to_value(&events).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_list_comments(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.list_board_comments(&id) {
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
    match state
        .sqlite
        .link_session_to_issue(&id, &body.session_id, body.cost_usd, body.tokens)
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// Gantt: schedule update + project timeline.

/// Schedule body: `double_option` so we distinguish "field absent" (keep
/// existing) from "field explicitly null" (clear). `None` = untouched,
/// `Some(None)` = clear, `Some(Some(date))` = set.
#[derive(Deserialize)]
struct BoardScheduleBody {
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    due_date: Option<Option<String>>,
    #[serde(default = "default_web_user")]
    actor_id: String,
    #[serde(default = "default_web_ui")]
    actor_name: String,
    #[serde(default = "default_human")]
    actor_type: String,
}

fn default_web_user() -> String { "web-user".into() }
fn default_web_ui() -> String { "Web UI".into() }

fn deserialize_optional_field<'de, D>(de: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(de)?))
}

fn is_yyyy_mm_dd(s: &str) -> bool {
    if s.len() != 10 { return false; }
    let b = s.as_bytes();
    b[4] == b'-' && b[7] == b'-'
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

async fn board_schedule_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BoardScheduleBody>,
) -> impl IntoResponse {
    if body.start_date.is_none() && body.due_date.is_none() {
        return (StatusCode::BAD_REQUEST, "start_date or due_date required".to_string()).into_response();
    }
    if let Some(Some(ref s)) = body.start_date {
        if !is_yyyy_mm_dd(s) {
            return (StatusCode::BAD_REQUEST, "start_date must be YYYY-MM-DD".to_string()).into_response();
        }
    }
    if let Some(Some(ref d)) = body.due_date {
        if !is_yyyy_mm_dd(d) {
            return (StatusCode::BAD_REQUEST, "due_date must be YYYY-MM-DD".to_string()).into_response();
        }
    }

    match state.sqlite.schedule_board_issue(
        &id,
        body.start_date,
        body.due_date,
        &body.actor_id,
        &body.actor_name,
        &body.actor_type,
    ) {
        Ok(()) => match state.sqlite.get_board_issue(&id) {
            Ok(Some(issue)) => Json(serde_json::to_value(&issue).unwrap()).into_response(),
            Ok(None) => (StatusCode::NOT_FOUND, format!("issue not found: {}", id)).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("issue not found") {
                (StatusCode::NOT_FOUND, msg).into_response()
            } else if msg.contains("must be <=") {
                (StatusCode::BAD_REQUEST, msg).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

async fn board_gantt_for_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.get_board_project(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, format!("project not found: {}", id)).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
    match state.sqlite.gantt_for_project(&id) {
        Ok((min, max, issues)) => {
            // Emit a Gantt-tuned projection: narrower than full BoardIssue,
            // matching the Worker's GET /gantt response shape.
            let rows: Vec<serde_json::Value> = issues.iter().map(|i| {
                serde_json::json!({
                    "id": i.id,
                    "project_id": i.project_id,
                    "title": i.title,
                    "status": i.status.as_str(),
                    "priority": i.priority,
                    "assignee_id": i.assignee_id,
                    "assignee_name": i.assignee_name,
                    "assignee_type": i.assignee_type,
                    "parent_id": i.parent_id,
                    "start_date": i.start_date,
                    "due_date": i.due_date,
                })
            }).collect();
            Json(serde_json::json!({
                "range": { "min": min, "max": max },
                "issues": rows,
            })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn board_acceptance_rollup(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.acceptance_rollup(&id) {
        Ok(rollup) => Json(serde_json::to_value(&rollup).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardAcceptanceReportBody {
    status: String,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

async fn board_acceptance_report(
    State(state): State<Arc<AppState>>,
    Path((id, idx)): Path<(String, i64)>,
    Json(body): Json<BoardAcceptanceReportBody>,
) -> impl IntoResponse {
    let Some(status) = gctrl_core::AcceptanceStatus::from_str(&body.status) else {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "invalid status '{}' (expected pending|running|pass|fail)",
                body.status
            ),
        )
            .into_response();
    };
    match state.sqlite.upsert_acceptance_result(
        &id,
        idx,
        status,
        body.output.as_deref(),
        body.session_id.as_deref(),
    ) {
        Ok(true) => StatusCode::OK.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            format!("no check at idx {idx} for issue {id}"),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BoardImportBody {
    path: String,
}

async fn board_import_markdown(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BoardImportBody>,
) -> impl IntoResponse {
    let dir = std::path::Path::new(&body.path);
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a directory: {}", body.path),
        )
            .into_response();
    }

    let projects = match state.sqlite.list_board_projects() {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let parsed = match gctrl_storage::import_markdown_dir(dir, &projects) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };

    let mut imported = 0;
    let mut skipped = 0;
    for (issue, _id) in &parsed {
        match state.sqlite.upsert_board_issue(issue) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    }

    let result = serde_json::json!({
        "imported": imported,
        "skipped": skipped,
        "total": parsed.len(),
    });
    (StatusCode::OK, Json(result)).into_response()
}

#[derive(Deserialize)]
struct BoardExportBody {
    path: String,
    #[serde(default)]
    project_id: Option<String>,
}

async fn board_export_markdown(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BoardExportBody>,
) -> impl IntoResponse {
    let filter = gctrl_core::BoardIssueFilter {
        project_id: body.project_id,
        ..Default::default()
    };

    let issues = match state.sqlite.list_board_issues(&filter) {
        Ok(i) => i,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let projects = match state.sqlite.list_board_projects() {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let dir = std::path::Path::new(&body.path);
    match gctrl_storage::export_markdown_dir(dir, &issues, &projects) {
        Ok(written) => {
            let result = serde_json::json!({
                "exported": written.len(),
                "files": written,
            });
            (StatusCode::OK, Json(result)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// --- GitHub Driver Handlers (LKM — delegates to native `gh` CLI) ---

#[derive(Deserialize)]
struct GhRepoQuery {
    repo: String,
    #[serde(default = "default_gh_limit")]
    limit: usize,
    #[serde(default)]
    branch: Option<String>,
}

fn default_gh_limit() -> usize {
    10
}

/// Run `gh` CLI and return stdout as JSON Value.
async fn gh_exec(args: &[&str]) -> Result<serde_json::Value, (StatusCode, String)> {
    let output = tokio::process::Command::new("gh")
        .args(args)
        .output()
        .await
        .map_err(|e| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("gh CLI not available: {e}"),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((StatusCode::BAD_GATEWAY, format!("gh CLI error: {stderr}")));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("gh JSON parse error: {e}"),
        )
    })
}

async fn gh_list_issues(Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let limit_str = q.limit.to_string();
    match gh_exec(&[
        "issue",
        "list",
        "--repo",
        &q.repo,
        "--limit",
        &limit_str,
        "--json",
        "number,title,state,author,labels,createdAt,url,body",
    ])
    .await
    {
        Ok(val) => {
            // gh returns labels as [{name:"x"}], flatten to ["x"]
            let issues = normalize_gh_issues(val);
            Json(issues).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn gh_get_issue(Path(number): Path<u64>, Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let num_str = number.to_string();
    match gh_exec(&[
        "issue",
        "view",
        &num_str,
        "--repo",
        &q.repo,
        "--json",
        "number,title,state,author,labels,createdAt,url,body",
    ])
    .await
    {
        Ok(val) => {
            let issue = normalize_gh_issue(val);
            Json(issue).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

#[derive(Deserialize)]
struct GhCreateIssueBody {
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    labels: Option<Vec<String>>,
}

async fn gh_create_issue(
    Query(q): Query<GhRepoQuery>,
    Json(input): Json<GhCreateIssueBody>,
) -> impl IntoResponse {
    let mut args = vec![
        "issue".to_string(),
        "create".to_string(),
        "--repo".to_string(),
        q.repo.clone(),
        "--title".to_string(),
        input.title.clone(),
    ];
    if let Some(ref body) = input.body {
        args.push("--body".to_string());
        args.push(body.clone());
    }
    if let Some(ref labels) = input.labels {
        for l in labels {
            args.push("--label".to_string());
            args.push(l.clone());
        }
    }
    // gh issue create doesn't output JSON by default, use --json hack
    // Actually: we need to capture the created issue. Use `gh issue create` then parse.
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let output = tokio::process::Command::new("gh")
        .args(&arg_refs)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // gh issue create prints the URL on success, parse issue number from it
            let url = stdout.trim().to_string();
            let number = url
                .rsplit('/')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);

            let issue = serde_json::json!({
                "number": number,
                "title": input.title,
                "state": "open",
                "author": "gctrl-sync",
                "labels": input.labels.unwrap_or_default(),
                "createdAt": chrono::Utc::now().to_rfc3339(),
                "url": url,
            });
            (StatusCode::CREATED, Json(issue)).into_response()
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            (
                StatusCode::BAD_GATEWAY,
                format!("gh issue create failed: {stderr}"),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("gh CLI not available: {e}"),
        )
            .into_response(),
    }
}

async fn gh_list_prs(Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let limit_str = q.limit.to_string();
    match gh_exec(&[
        "pr",
        "list",
        "--repo",
        &q.repo,
        "--limit",
        &limit_str,
        "--json",
        "number,title,state,author,headRefName,url",
    ])
    .await
    {
        Ok(val) => {
            let prs = normalize_gh_prs(val);
            Json(prs).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn gh_get_pr(Path(number): Path<u64>, Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let num_str = number.to_string();
    match gh_exec(&[
        "pr",
        "view",
        &num_str,
        "--repo",
        &q.repo,
        "--json",
        "number,title,state,author,headRefName,url",
    ])
    .await
    {
        Ok(val) => {
            let pr = normalize_gh_pr(val);
            Json(pr).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn gh_list_runs(Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let limit_str = q.limit.to_string();
    let mut args = vec![
        "run",
        "list",
        "--repo",
        &q.repo,
        "--limit",
        &limit_str,
        "--json",
        "databaseId,name,status,conclusion,headBranch,url",
    ];
    let branch_val;
    if let Some(ref b) = q.branch {
        branch_val = b.clone();
        args.push("--branch");
        args.push(&branch_val);
    }
    match gh_exec(&args).await {
        Ok(val) => {
            let runs = normalize_gh_runs(val);
            Json(runs).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

async fn gh_get_run(Path(run_id): Path<u64>, Query(q): Query<GhRepoQuery>) -> impl IntoResponse {
    let id_str = run_id.to_string();
    match gh_exec(&[
        "run",
        "view",
        &id_str,
        "--repo",
        &q.repo,
        "--json",
        "databaseId,name,status,conclusion,headBranch,url",
    ])
    .await
    {
        Ok(val) => {
            let run = normalize_gh_run(val);
            Json(run).into_response()
        }
        Err((status, msg)) => (status, msg).into_response(),
    }
}

// --- Contributions: trailer-inferred join from gh artifacts → kernel sessions ---
//
// Spec: vault/specs/architecture/apps/gctrl-analytics.md Kernel Deps §4
// + Milestone M5. Inference-first: agents append `Session-Id: <uuid>`
// trailers; this route extracts them at query time and joins to local
// sessions. Missing trailer = "unattributed" row, still shown.

#[derive(Deserialize)]
struct ContributionsQuery {
    repo: String,
    /// Per-source row cap (PRs and commits each pull up to `limit`).
    #[serde(default = "default_contributions_limit")]
    limit: usize,
    /// Optional time floor as `YYYY-MM-DD` *or* a relative shorthand
    /// `7d`, `30d`, `90d`. Relative values are resolved server-side
    /// against `Utc::now()` so cached responses stay coherent. Empty
    /// or omitted ⇒ no time filter (today's `gh pr list` default).
    #[serde(default)]
    since: Option<String>,
    /// Filter joined sessions by `?kind=internal|external` *or*
    /// `?created_by=...`, mirroring the analytics rollup vocabulary.
    /// Rows whose joined session falls outside the filter are dropped;
    /// rows with no joined session are kept iff `kind` is unset
    /// (otherwise the operator asked for a known population).
    #[serde(default)]
    created_by: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

fn default_contributions_limit() -> usize {
    20
}

/// Resolve `?since=` into an ISO-8601 date string (`YYYY-MM-DD`)
/// suitable for both `gh pr list --search created:>=...` and the
/// commits API's `since=...` param. Returns `None` for empty / invalid
/// input rather than 400ing — the route is read-only and a malformed
/// `since` is recoverable by simply ignoring it.
pub(crate) fn resolve_since(raw: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Relative shorthand: `7d`, `30d`, `90d`, etc.
    if let Some(days_str) = trimmed.strip_suffix('d') {
        if let Ok(days) = days_str.parse::<i64>() {
            if days > 0 {
                let cutoff = now - chrono::Duration::days(days);
                return Some(cutoff.format("%Y-%m-%d").to_string());
            }
        }
        return None;
    }
    // Absolute: accept `YYYY-MM-DD` exactly. We deliberately don't try
    // to parse arbitrary ISO timestamps — any time-of-day precision is
    // lost when GitHub's `created:>=` operator only honours the date.
    if chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").is_ok() {
        return Some(trimmed.to_string());
    }
    None
}

async fn list_contributions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ContributionsQuery>,
) -> impl IntoResponse {
    let limit_str = params.limit.to_string();
    let prov_filter =
        parse_created_by_filter(params.created_by.as_deref(), params.kind.as_deref());
    let store = state.store.clone();

    let since_iso = params
        .since
        .as_deref()
        .and_then(|s| resolve_since(s, chrono::Utc::now()));

    // PRs — `gh pr list` returns body so we scan trailers without a
    // second `gh pr view` per row. When `since` is present, narrow
    // via GitHub's search syntax — `created:>=YYYY-MM-DD`.
    let mut pr_args: Vec<String> = vec![
        "pr".into(),
        "list".into(),
        "--repo".into(),
        params.repo.clone(),
        "--limit".into(),
        limit_str.clone(),
        "--state".into(),
        "all".into(),
        "--json".into(),
        "number,title,body,author,headRefName,url,state,mergedAt,createdAt".into(),
    ];
    if let Some(since) = since_iso.as_deref() {
        pr_args.push("--search".into());
        pr_args.push(format!("created:>={since}"));
    }
    let pr_arg_refs: Vec<&str> = pr_args.iter().map(|s| s.as_str()).collect();
    let pr_raw = match gh_exec(&pr_arg_refs).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, msg).into_response(),
    };

    // Commits — `gh api repos/{repo}/commits` returns the full message
    // body so trailers from squash-merged commits surface even when the
    // PR body itself was empty. `gh search commits` would also work but
    // requires a non-empty query, so the per-repo listing is simpler.
    // GitHub's commits API takes `since=YYYY-MM-DDTHH:MM:SSZ` natively;
    // we pad the resolved date with `T00:00:00Z`.
    let mut commit_path = format!("repos/{}/commits?per_page={}", params.repo, params.limit);
    if let Some(since) = since_iso.as_deref() {
        commit_path.push_str(&format!("&since={since}T00:00:00Z"));
    }
    let commit_raw = match gh_exec(&["api", &commit_path]).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, msg).into_response(),
    };

    let mut rows: Vec<serde_json::Value> = Vec::new();
    for pr in pr_raw.as_array().cloned().unwrap_or_default() {
        let row = build_contribution_row(&pr, |sid| {
            store
                .get_session(&gctrl_core::SessionId(sid.into()))
                .ok()
                .flatten()
        });
        if contribution_passes_filter(&row, prov_filter.as_deref()) {
            rows.push(row);
        }
    }
    for c in commit_raw.as_array().cloned().unwrap_or_default() {
        let row = build_commit_row(&c, |sid| {
            store
                .get_session(&gctrl_core::SessionId(sid.into()))
                .ok()
                .flatten()
        });
        if contribution_passes_filter(&row, prov_filter.as_deref()) {
            rows.push(row);
        }
    }

    // Sort merged list by created_at desc — null timestamps sort last
    // (treat as oldest) so dated rows always land first.
    rows.sort_by(|a, b| {
        let ka = a.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let kb = b.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        kb.cmp(ka)
    });

    Json(serde_json::json!({ "contributions": rows })).into_response()
}

/// Join a single PR-shaped JSON value to a local session via the
/// `Session-Id:` trailer in its body. Returns the contribution row in
/// the wire shape the UI consumes.
///
/// Pure of storage: takes a `lookup_session` closure so tests don't
/// need a router or DuckDB instance — just a `HashMap` shim.
pub(crate) fn build_contribution_row<F>(
    pr: &serde_json::Value,
    lookup_session: F,
) -> serde_json::Value
where
    F: FnOnce(&str) -> Option<gctrl_core::Session>,
{
    let body = pr.get("body").and_then(|b| b.as_str()).unwrap_or("");
    let session_id = crate::contributions::parse_session_trailer(body);

    // Look up the session — we want both the `created_by` (for the
    // kind filter) and `agent_name` (for the row label).
    let session_meta = session_id.as_deref().and_then(lookup_session);

    let author = pr
        .get("author")
        .and_then(|a| a.get("login"))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .to_string();

    serde_json::json!({
        "type": "pr",
        "number": pr.get("number").cloned().unwrap_or(serde_json::Value::Null),
        "title": pr.get("title").cloned().unwrap_or(serde_json::Value::Null),
        "url": pr.get("url").cloned().unwrap_or(serde_json::Value::Null),
        "state": pr.get("state").cloned().unwrap_or(serde_json::Value::Null),
        "merged_at": pr.get("mergedAt").cloned().unwrap_or(serde_json::Value::Null),
        "created_at": pr.get("createdAt").cloned().unwrap_or(serde_json::Value::Null),
        "branch": pr.get("headRefName").cloned().unwrap_or(serde_json::Value::Null),
        "author": author,
        "session_id": session_id,
        "session_agent": session_meta.as_ref().map(|s| s.agent_name.clone()),
        "created_by": session_meta.as_ref().map(|s| s.created_by.as_str()),
    })
}

/// Same shape as `build_contribution_row`, but for raw GitHub API
/// commit JSON (`gh api repos/{owner}/{repo}/commits`). Commits don't
/// carry a `state`; they're always landed, so we synthesize
/// `state="merged"` so the UI's state badge stays consistent.
///
/// `number` is set to `0` because commits are referenced by SHA, not
/// number — the UI displays `sha[..7]` instead. We keep `number: 0`
/// rather than `null` so the UI renderer doesn't have to special-case
/// missing integer keys.
pub(crate) fn build_commit_row<F>(
    commit: &serde_json::Value,
    lookup_session: F,
) -> serde_json::Value
where
    F: FnOnce(&str) -> Option<gctrl_core::Session>,
{
    let message = commit
        .get("commit")
        .and_then(|c| c.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let session_id = crate::contributions::parse_session_trailer(message);
    let session_meta = session_id.as_deref().and_then(lookup_session);

    // Subject line = first non-empty line of the commit message.
    let title = message
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .to_string();
    let sha = commit
        .get("sha")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let author = commit
        .get("commit")
        .and_then(|c| c.get("author"))
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .or_else(|| {
            commit
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|l| l.as_str())
        })
        .unwrap_or("")
        .to_string();
    let created_at = commit
        .get("commit")
        .and_then(|c| c.get("author"))
        .and_then(|a| a.get("date"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let url = commit
        .get("html_url")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    serde_json::json!({
        "type": "commit",
        "number": 0,
        "sha": sha,
        "title": title,
        "url": url,
        "state": "merged",
        "merged_at": created_at,
        "created_at": created_at,
        "branch": serde_json::Value::Null,
        "author": author,
        "session_id": session_id,
        "session_agent": session_meta.as_ref().map(|s| s.agent_name.clone()),
        "created_by": session_meta.as_ref().map(|s| s.created_by.as_str()),
    })
}

/// Apply the `kind`/`created_by` filter to a contribution row. When
/// the filter is absent every row passes; when present, rows without a
/// joined session are dropped (the operator narrowed to a known
/// population, so unattributed rows would mislead the totals).
pub(crate) fn contribution_passes_filter(
    row: &serde_json::Value,
    prov_filter: Option<&[gctrl_core::CreatedBy]>,
) -> bool {
    let Some(filter) = prov_filter else {
        return true;
    };
    let Some(created_by_str) = row.get("created_by").and_then(|v| v.as_str()) else {
        return false;
    };
    let Some(prov) = gctrl_core::CreatedBy::from_str(created_by_str) else {
        return false;
    };
    filter.contains(&prov)
}

/// Normalize `gh issue list` JSON: flatten author.login, labels[].name
fn normalize_gh_issues(val: serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(normalize_gh_issue).collect())
        }
        other => other,
    }
}

fn normalize_gh_issue(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = v.as_object_mut() {
        // author: {login: "x"} → "x"
        if let Some(author) = obj.get("author").cloned() {
            if let Some(login) = author.get("login").and_then(|l| l.as_str()) {
                obj.insert("author".into(), serde_json::Value::String(login.into()));
            }
        }
        // labels: [{name: "x"}] → ["x"]
        if let Some(labels) = obj.get("labels").cloned() {
            if let Some(arr) = labels.as_array() {
                let flat: Vec<serde_json::Value> = arr
                    .iter()
                    .filter_map(|l| {
                        l.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| serde_json::Value::String(s.into()))
                    })
                    .collect();
                obj.insert("labels".into(), serde_json::Value::Array(flat));
            }
        }
    }
    v
}

fn normalize_gh_prs(val: serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(normalize_gh_pr).collect())
        }
        other => other,
    }
}

fn normalize_gh_pr(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = v.as_object_mut() {
        // author: {login: "x"} → "x"
        if let Some(author) = obj.get("author").cloned() {
            if let Some(login) = author.get("login").and_then(|l| l.as_str()) {
                obj.insert("author".into(), serde_json::Value::String(login.into()));
            }
        }
        // headRefName → branch
        if let Some(head) = obj.remove("headRefName") {
            obj.insert("branch".into(), head);
        }
    }
    v
}

fn normalize_gh_runs(val: serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(normalize_gh_run).collect())
        }
        other => other,
    }
}

fn normalize_gh_run(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = v.as_object_mut() {
        // databaseId → id
        if let Some(db_id) = obj.remove("databaseId") {
            obj.insert("id".into(), db_id);
        }
        // headBranch → branch
        if let Some(head) = obj.remove("headBranch") {
            obj.insert("branch".into(), head);
        }
    }
    v
}

// --- Generic CLI passthrough (shared by wrangler + gh drivers) ---

#[derive(Deserialize)]
struct CliExecBody {
    #[serde(default)]
    args: Vec<String>,
    /// Optional working directory — must be an absolute path on the kernel host.
    #[serde(default)]
    cwd: Option<String>,
}

/// Run `<bin> <args...>` and return a structured envelope.
///
/// The envelope always carries `exitCode` so the shell can mirror it without
/// conflating subprocess exit status with HTTP status. HTTP 200 on spawn
/// success (even for nonzero exit), 502 only when the binary cannot be
/// launched at all.
async fn cli_exec(bin: &str, body: CliExecBody) -> axum::response::Response {
    let start = std::time::Instant::now();
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(&body.args);
    if let Some(cwd) = body.cwd.as_ref() {
        cmd.current_dir(cwd);
    }

    match cmd.output().await {
        Ok(out) => {
            let envelope = serde_json::json!({
                "stdout": String::from_utf8_lossy(&out.stdout),
                "stderr": String::from_utf8_lossy(&out.stderr),
                "exitCode": out.status.code().unwrap_or(-1),
                "durationMs": start.elapsed().as_millis() as u64,
            });
            Json(envelope).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("{bin} CLI not available: {e}"),
        )
            .into_response(),
    }
}

async fn wrangler_exec_passthrough(Json(body): Json<CliExecBody>) -> impl IntoResponse {
    cli_exec("wrangler", body).await
}

async fn gh_exec_passthrough(Json(body): Json<CliExecBody>) -> impl IntoResponse {
    cli_exec("gh", body).await
}

// --- Wrangler Driver Handlers (LKM — delegates to native `wrangler` CLI) ---

async fn wrangler_whoami() -> impl IntoResponse {
    let output = tokio::process::Command::new("wrangler")
        .arg("whoami")
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            Json(parse_wrangler_whoami(&stdout)).into_response()
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            (
                StatusCode::BAD_GATEWAY,
                format!("wrangler whoami failed: {stderr}"),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("wrangler CLI not available: {e}"),
        )
            .into_response(),
    }
}

/// Parse the text output of `wrangler whoami` into a structured JSON envelope.
///
/// Wrangler emits decorated text (no `--json` flag for whoami as of v4), so we
/// extract:
/// - `email`   — first quoted string on the "associated with the email" line
/// - `accounts`— `[{name,id}]` rows from the ASCII table (skips header + divider)
/// - `raw`     — the original stdout for callers that want the full output
fn parse_wrangler_whoami(stdout: &str) -> serde_json::Value {
    let email = stdout
        .lines()
        .find(|l| l.contains("associated with the email"))
        .and_then(|l| {
            let start = l.find('\'')?;
            let rest = &l[start + 1..];
            let end = rest.find('\'')?;
            Some(rest[..end].to_string())
        });

    let mut accounts: Vec<serde_json::Value> = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('│') {
            continue;
        }
        let cells: Vec<&str> = trimmed
            .trim_matches('│')
            .split('│')
            .map(|c| c.trim())
            .collect();
        if cells.len() != 2 {
            continue;
        }
        let (name, id) = (cells[0], cells[1]);
        // Skip header and empty rows.
        if name.eq_ignore_ascii_case("Account Name") || name.is_empty() || id.is_empty() {
            continue;
        }
        accounts.push(serde_json::json!({ "name": name, "id": id }));
    }

    serde_json::json!({
        "email": email,
        "accounts": accounts,
        "raw": stdout,
    })
}

// --- Persona Handlers ---

async fn persona_list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.sqlite.list_personas() {
        Ok(personas) => Json(serde_json::to_value(&personas).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn persona_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.get_persona(&id) {
        Ok(Some(persona)) => Json(serde_json::to_value(&persona).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("persona '{}' not found", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct PersonaUpsertBody {
    id: String,
    name: String,
    focus: String,
    prompt_prefix: String,
    #[serde(default)]
    owns: String,
    #[serde(default)]
    review_focus: String,
    #[serde(default)]
    pushes_back: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    key_specs: Vec<String>,
    #[serde(default)]
    source_hash: Option<String>,
}

async fn persona_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PersonaUpsertBody>,
) -> impl IntoResponse {
    let persona = gctrl_core::PersonaDefinition {
        id: body.id,
        name: body.name,
        focus: body.focus,
        prompt_prefix: body.prompt_prefix,
        owns: body.owns,
        review_focus: body.review_focus,
        pushes_back: body.pushes_back,
        tools: body.tools,
        key_specs: body.key_specs,
        source_hash: body.source_hash,
    };
    match state.sqlite.upsert_persona(&persona) {
        Ok(true) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&persona).unwrap()),
        )
            .into_response(),
        Ok(false) => Json(serde_json::to_value(&persona).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct PersonaSeedBody {
    personas: Vec<PersonaUpsertBody>,
    #[serde(default)]
    review_rules: Vec<ReviewRuleBody>,
}

async fn persona_seed(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PersonaSeedBody>,
) -> impl IntoResponse {
    let mut created = 0u32;
    let mut updated = 0u32;
    for p in body.personas {
        let persona = gctrl_core::PersonaDefinition {
            id: p.id,
            name: p.name,
            focus: p.focus,
            prompt_prefix: p.prompt_prefix,
            owns: p.owns,
            review_focus: p.review_focus,
            pushes_back: p.pushes_back,
            tools: p.tools,
            key_specs: p.key_specs,
            source_hash: p.source_hash,
        };
        match state.sqlite.upsert_persona(&persona) {
            Ok(true) => created += 1,
            Ok(false) => updated += 1,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    }
    for r in body.review_rules {
        let rule = gctrl_core::PersonaReviewRule {
            id: r.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            pr_type: r.pr_type,
            persona_ids: r.persona_ids,
        };
        if let Err(e) = state.sqlite.upsert_review_rule(&rule) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    Json(serde_json::json!({ "created": created, "updated": updated })).into_response()
}

async fn persona_delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.delete_persona(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, format!("persona '{}' not found", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ReviewRuleBody {
    #[serde(default)]
    id: Option<String>,
    pr_type: String,
    persona_ids: Vec<String>,
}

async fn persona_review_rules_list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.sqlite.list_review_rules() {
        Ok(rules) => Json(serde_json::to_value(&rules).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn persona_review_rules_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReviewRuleBody>,
) -> impl IntoResponse {
    let rule = gctrl_core::PersonaReviewRule {
        id: body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        pr_type: body.pr_type,
        persona_ids: body.persona_ids,
    };
    match state.sqlite.upsert_review_rule(&rule) {
        Ok(_) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&rule).unwrap()),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// --- Team Handlers ---

#[derive(Deserialize)]
struct TeamRecommendBody {
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    pr_type: Option<String>,
}

async fn team_recommend(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TeamRecommendBody>,
) -> impl IntoResponse {
    // 1. If pr_type matches a review rule, return that rule's persona set
    if let Some(ref pr_type) = body.pr_type {
        if let Ok(Some(rule)) = state.sqlite.get_review_rule_by_type(pr_type) {
            let mut personas = Vec::new();
            for pid in &rule.persona_ids {
                if let Ok(Some(p)) = state.sqlite.get_persona(pid) {
                    personas.push(p);
                }
            }
            let result = gctrl_core::TeamRecommendation {
                personas,
                rationale: format!("Matched review rule '{}'", pr_type),
            };
            return Json(serde_json::to_value(&result).unwrap()).into_response();
        }
    }

    // 2. Match labels against persona owns/focus text
    let all_personas = match state.sqlite.list_personas() {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let mut matched: Vec<gctrl_core::PersonaDefinition> = Vec::new();
    let labels_lower: Vec<String> = body.labels.iter().map(|l| l.to_lowercase()).collect();

    for persona in &all_personas {
        let text = format!("{} {} {}", persona.owns, persona.focus, persona.id).to_lowercase();
        if labels_lower.iter().any(|l| text.contains(l.as_str())) {
            matched.push(persona.clone());
        }
    }

    // Always include engineer as baseline if not already present
    if !matched.iter().any(|p| p.id == "engineer") {
        if let Some(eng) = all_personas.iter().find(|p| p.id == "engineer") {
            matched.insert(0, eng.clone());
        }
    }

    let rationale = if matched.is_empty() {
        "No personas matched the given labels".to_string()
    } else {
        let names: Vec<&str> = matched.iter().map(|p| p.name.as_str()).collect();
        format!("Matched by labels {:?}: {}", body.labels, names.join(", "))
    };

    let result = gctrl_core::TeamRecommendation {
        personas: matched,
        rationale,
    };
    Json(serde_json::to_value(&result).unwrap()).into_response()
}

#[derive(Deserialize)]
struct TeamRenderBody {
    persona_ids: Vec<String>,
    #[serde(default)]
    context: Option<serde_json::Value>,
}

async fn team_render(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TeamRenderBody>,
) -> impl IntoResponse {
    let mut agents = Vec::new();
    let context_str = body
        .context
        .as_ref()
        .map(|c| serde_json::to_string_pretty(c).unwrap_or_default())
        .unwrap_or_default();

    for pid in &body.persona_ids {
        match state.sqlite.get_persona(pid) {
            Ok(Some(persona)) => {
                let mut prompt = persona.prompt_prefix.clone();
                if !context_str.is_empty() {
                    prompt.push_str(&format!("\n\n## Task Context\n{}", context_str));
                }
                if !persona.key_specs.is_empty() {
                    prompt.push_str("\n\n## Key Specs to Reference\n");
                    for spec in &persona.key_specs {
                        prompt.push_str(&format!("- {}\n", spec));
                    }
                }
                if !persona.review_focus.is_empty() {
                    prompt.push_str(&format!(
                        "\n## Your Review Focus\n{}\n",
                        persona.review_focus
                    ));
                }
                agents.push(gctrl_core::RenderedPersonaPrompt {
                    persona_id: persona.id,
                    name: persona.name,
                    prompt,
                });
            }
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    format!("persona '{}' not found", pid),
                )
                    .into_response();
            }
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
            }
        }
    }

    Json(serde_json::json!({ "agents": agents })).into_response()
}

// --- Inbox Handlers ---

#[derive(Deserialize)]
struct InboxCreateMessageBody {
    #[serde(default)]
    thread_id: Option<String>,
    source: String,
    kind: String,
    #[serde(default = "default_inbox_urgency")]
    urgency: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default = "default_inbox_context")]
    context: serde_json::Value,
    #[serde(default)]
    requires_action: bool,
    #[serde(default)]
    payload: Option<serde_json::Value>,
    #[serde(default)]
    expires_at: Option<String>,
    // Thread auto-grouping fields
    #[serde(default)]
    context_type: Option<String>,
    #[serde(default)]
    context_ref: Option<String>,
    #[serde(default)]
    thread_title: Option<String>,
    #[serde(default)]
    project_key: Option<String>,
}

fn default_inbox_urgency() -> String {
    "medium".into()
}
fn default_inbox_context() -> serde_json::Value {
    serde_json::json!({})
}

async fn inbox_create_message(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InboxCreateMessageBody>,
) -> impl IntoResponse {
    // Validate enum fields
    const VALID_KINDS: &[&str] = &[
        "permission_request",
        "budget_warning",
        "budget_exceeded",
        "agent_question",
        "clarification",
        "review_request",
        "eval_request",
        "status_update",
        "custom",
    ];
    const VALID_URGENCIES: &[&str] = &["critical", "high", "medium", "low", "info"];

    if !VALID_KINDS.contains(&body.kind.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid kind: {}", body.kind),
        )
            .into_response();
    }
    if !VALID_URGENCIES.contains(&body.urgency.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid urgency: {}", body.urgency),
        )
            .into_response();
    }

    let now = chrono::Utc::now().to_rfc3339();

    // Resolve or create thread
    let thread_id = if let Some(tid) = body.thread_id {
        tid
    } else if let (Some(ct), Some(cr)) = (body.context_type.as_deref(), body.context_ref.as_deref())
    {
        let title = body.thread_title.as_deref().unwrap_or(cr);
        match state
            .sqlite
            .get_or_create_inbox_thread(ct, cr, title, body.project_key.as_deref())
        {
            Ok(t) => t.id,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            "either thread_id or (context_type + context_ref) required".to_string(),
        )
            .into_response();
    };

    let msg = gctrl_core::InboxMessage {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id,
        source: body.source,
        kind: body.kind,
        urgency: body.urgency,
        title: body.title,
        body: body.body,
        context: body.context,
        status: "pending".into(),
        requires_action: body.requires_action,
        payload: body.payload,
        duplicate_count: 0,
        snoozed_until: None,
        expires_at: body.expires_at,
        created_at: now.clone(),
        updated_at: now,
    };

    match state.sqlite.create_inbox_message(&msg) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&msg).unwrap()),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn inbox_get_message(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.sqlite.get_inbox_message(&id) {
        Ok(Some(msg)) => Json(serde_json::to_value(&msg).unwrap()).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, format!("message not found: {}", id)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct InboxMessageListParams {
    status: Option<String>,
    urgency: Option<String>,
    kind: Option<String>,
    project: Option<String>,
    requires_action: Option<bool>,
    #[serde(default = "default_inbox_limit")]
    limit: usize,
}

fn default_inbox_limit() -> usize {
    50
}

async fn inbox_list_messages(
    State(state): State<Arc<AppState>>,
    Query(params): Query<InboxMessageListParams>,
) -> impl IntoResponse {
    let filter = gctrl_core::InboxMessageFilter {
        status: params.status,
        urgency: params.urgency,
        kind: params.kind,
        project: params.project,
        thread_id: None,
        requires_action: params.requires_action,
        limit: Some(params.limit),
    };
    match state.sqlite.list_inbox_messages(&filter) {
        Ok(msgs) => Json(serde_json::to_value(&msgs).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn inbox_get_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let thread = match state.sqlite.get_inbox_thread(&id) {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, format!("thread not found: {}", id)).into_response()
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    // Include messages for the thread (shell expects InboxThreadWithMessages)
    let filter = gctrl_core::InboxMessageFilter {
        thread_id: Some(id),
        ..Default::default()
    };
    let messages = match state.sqlite.list_inbox_messages(&filter) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let mut value = serde_json::to_value(&thread).unwrap();
    value.as_object_mut().unwrap().insert(
        "messages".to_string(),
        serde_json::to_value(&messages).unwrap(),
    );
    Json(value).into_response()
}

#[derive(Deserialize)]
struct InboxThreadListParams {
    project: Option<String>,
    has_pending: Option<bool>,
    #[serde(default = "default_inbox_limit")]
    limit: usize,
}

async fn inbox_list_threads(
    State(state): State<Arc<AppState>>,
    Query(params): Query<InboxThreadListParams>,
) -> impl IntoResponse {
    match state.sqlite.list_inbox_threads(
        params.project.as_deref(),
        params.has_pending,
        Some(params.limit),
    ) {
        Ok(threads) => Json(serde_json::to_value(&threads).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct InboxCreateActionBody {
    message_id: String,
    action_type: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    #[serde(default = "default_inbox_actor_id")]
    actor_id: String,
    #[serde(default = "default_inbox_actor_name")]
    actor_name: String,
}

fn default_inbox_actor_id() -> String {
    "default".into()
}
fn default_inbox_actor_name() -> String {
    "human".into()
}

async fn inbox_create_action(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InboxCreateActionBody>,
) -> impl IntoResponse {
    const VALID_ACTIONS: &[&str] = &[
        "approve",
        "deny",
        "acknowledge",
        "defer",
        "delegate",
        "escalate",
        "reply",
    ];
    if !VALID_ACTIONS.contains(&body.action_type.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid action_type: {}", body.action_type),
        )
            .into_response();
    }
    if let Some(ref reason) = body.reason {
        if reason.len() > 2000 {
            return (
                StatusCode::BAD_REQUEST,
                "reason exceeds 2000 character limit",
            )
                .into_response();
        }
    }

    // Look up message to get thread_id
    let msg = match state.sqlite.get_inbox_message(&body.message_id) {
        Ok(Some(m)) => m,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                format!("message not found: {}", body.message_id),
            )
                .into_response()
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let action = gctrl_core::InboxAction {
        id: uuid::Uuid::new_v4().to_string(),
        message_id: body.message_id,
        thread_id: msg.thread_id,
        actor_id: body.actor_id,
        actor_name: body.actor_name,
        action_type: body.action_type,
        reason: body.reason,
        metadata: body.metadata,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    match state.sqlite.create_inbox_action(&action) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::to_value(&action).unwrap()),
        )
            .into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("expected 'pending'") {
                (StatusCode::CONFLICT, msg).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
            }
        }
    }
}

#[derive(Deserialize)]
struct InboxBatchActionBody {
    message_ids: Vec<String>,
    action_type: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default = "default_inbox_actor_id")]
    actor_id: String,
    #[serde(default = "default_inbox_actor_name")]
    actor_name: String,
}

async fn inbox_batch_action(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InboxBatchActionBody>,
) -> impl IntoResponse {
    if body.message_ids.len() > 100 {
        return (StatusCode::BAD_REQUEST, "batch size exceeds limit of 100").into_response();
    }
    const VALID_ACTIONS: &[&str] = &[
        "approve",
        "deny",
        "acknowledge",
        "defer",
        "delegate",
        "escalate",
        "reply",
    ];
    if !VALID_ACTIONS.contains(&body.action_type.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid action_type: {}", body.action_type),
        )
            .into_response();
    }
    if let Some(ref reason) = body.reason {
        if reason.len() > 2000 {
            return (
                StatusCode::BAD_REQUEST,
                "reason exceeds 2000 character limit",
            )
                .into_response();
        }
    }

    let mut results = Vec::new();

    for mid in &body.message_ids {
        let msg = match state.sqlite.get_inbox_message(mid) {
            Ok(Some(m)) => m,
            Ok(None) => {
                results.push(serde_json::json!({
                    "message_id": mid,
                    "result": "skipped",
                    "skip_reason": "message not found"
                }));
                continue;
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "message_id": mid,
                    "result": "skipped",
                    "skip_reason": e.to_string()
                }));
                continue;
            }
        };

        if msg.status != "pending" {
            results.push(serde_json::json!({
                "message_id": mid,
                "result": "skipped",
                "skip_reason": format!("status is '{}', not 'pending'", msg.status)
            }));
            continue;
        }

        let action = gctrl_core::InboxAction {
            id: uuid::Uuid::new_v4().to_string(),
            message_id: mid.clone(),
            thread_id: msg.thread_id,
            actor_id: body.actor_id.clone(),
            actor_name: body.actor_name.clone(),
            action_type: body.action_type.clone(),
            reason: body.reason.clone(),
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        match state.sqlite.create_inbox_action(&action) {
            Ok(()) => {
                results.push(serde_json::json!({
                    "message_id": mid,
                    "result": "success"
                }));
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "message_id": mid,
                    "result": "skipped",
                    "skip_reason": e.to_string()
                }));
            }
        }
    }

    Json(serde_json::json!({ "results": results })).into_response()
}

#[derive(Deserialize)]
struct InboxActionListParams {
    actor: Option<String>,
    since: Option<String>,
    thread_id: Option<String>,
    #[serde(default = "default_inbox_limit")]
    limit: usize,
}

async fn inbox_list_actions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<InboxActionListParams>,
) -> impl IntoResponse {
    let filter = gctrl_core::InboxActionFilter {
        actor_id: params.actor,
        since: params.since,
        thread_id: params.thread_id,
        limit: Some(params.limit),
    };
    match state.sqlite.list_inbox_actions(&filter) {
        Ok(actions) => Json(serde_json::to_value(&actions).unwrap()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn inbox_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.sqlite.get_inbox_stats() {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize, Default)]
struct SyncPushBody {
    /// Tables to push. Empty = all SQLite-backed (board) tables.
    #[serde(default)]
    tables: Vec<String>,
}

async fn sync_push(
    State(state): State<Arc<AppState>>,
    body: Option<Json<SyncPushBody>>,
) -> impl IntoResponse {
    let Some(config) = state.sync_config.as_ref().filter(|c| c.d1_enabled()) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "D1 sync not configured — set GCTRL_D1_DATABASE_ID, GCTRL_D1_ACCOUNT_ID, GCTRL_D1_API_TOKEN",
        )
            .into_response();
    };

    // R2SyncEngine needs an owned DuckDB Connection; board-table pushes don't
    // touch DuckDB so a throwaway in-memory one is fine. This keeps the kernel's
    // single DuckDB connection free for reads during the push.
    let conn = match duckdb::Connection::open_in_memory() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let sync_dir = std::env::temp_dir().join("gctrl-sync-staging");
    let engine = gctrl_sync::R2SyncEngine::new(
        conn,
        config.as_ref().clone(),
        sync_dir,
        "default".to_string(),
    )
    .with_sqlite(Arc::clone(&state.sqlite));

    // Default empty body to the tables that route through `self.sqlite`
    // inside `push_table_to_d1`. Passing `&[]` to the engine would expand to
    // every syncable table (including DuckDB-backed `sessions`, `spans`,
    // `tasks`) — but this handler gives the engine a throwaway in-memory
    // DuckDB with no schema, so those branches error with "Table … does not
    // exist". R2/DuckDB sync should land via a separate path once the real
    // store connection is wired through.
    const HANDLER_DEFAULT_TABLES: &[&str] = &[
        "board_projects",
        "board_issues",
        "board_comments",
        "board_events",
        "memory_entries",
    ];
    let requested = body.map(|Json(b)| b.tables).unwrap_or_default();
    let defaulted: Vec<&str> = if requested.is_empty() {
        HANDLER_DEFAULT_TABLES.to_vec()
    } else {
        requested.iter().map(String::as_str).collect()
    };

    use gctrl_sync::SyncEngine;
    match engine.push(&defaulted).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ------------------------------------------------------------
// Search & Net drivers (Brave Search, Cloudflare Browser Rendering)
// ------------------------------------------------------------

fn net_error_status(e: &gctrl_net::NetError) -> StatusCode {
    match e {
        gctrl_net::NetError::MissingApiKey { .. } => StatusCode::SERVICE_UNAVAILABLE,
        gctrl_net::NetError::BackendError { status, .. } if *status >= 400 && *status < 500 => {
            StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY)
        }
        _ => StatusCode::BAD_GATEWAY,
    }
}

async fn run_search(
    state: &Arc<AppState>,
    kind: gctrl_net::SearchKind,
    query: gctrl_net::SearchQuery,
) -> axum::response::Response {
    let Some(api_key) = state.net_config.brave_api_key.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "BRAVE_SEARCH_API_KEY not configured",
        )
            .into_response();
    };
    let client = gctrl_net::BraveSearchClient::with_client(state.http_client.clone(), api_key);
    match client.search(kind, &query).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => (net_error_status(&e), e.to_string()).into_response(),
    }
}

async fn search_web(
    State(state): State<Arc<AppState>>,
    Json(q): Json<gctrl_net::SearchQuery>,
) -> impl IntoResponse {
    run_search(&state, gctrl_net::SearchKind::Web, q).await
}

async fn search_news(
    State(state): State<Arc<AppState>>,
    Json(q): Json<gctrl_net::SearchQuery>,
) -> impl IntoResponse {
    run_search(&state, gctrl_net::SearchKind::News, q).await
}

async fn search_images(
    State(state): State<Arc<AppState>>,
    Json(q): Json<gctrl_net::SearchQuery>,
) -> impl IntoResponse {
    run_search(&state, gctrl_net::SearchKind::Images, q).await
}

#[derive(Deserialize)]
struct NetFetchBody {
    url: String,
    #[serde(default)]
    render: Option<gctrl_net::RenderMode>,
    #[serde(default = "default_readability")]
    readability: bool,
    #[serde(default = "default_min_words")]
    min_words: usize,
}

fn default_readability() -> bool {
    true
}
fn default_min_words() -> usize {
    50
}

async fn net_fetch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NetFetchBody>,
) -> impl IntoResponse {
    let render = body.render.unwrap_or(gctrl_net::RenderMode::Static);
    let opts = gctrl_net::FetchOptions {
        readability: body.readability,
        min_words: body.min_words,
        render,
        cf_account_id: state.net_config.cf_account_id.clone(),
        cf_api_token: state.net_config.cf_api_token.clone(),
        ..Default::default()
    };
    match gctrl_net::fetch_page(&body.url, &opts).await {
        Ok(page) => Json(page).into_response(),
        Err(e) => (net_error_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct NetRenderBody {
    url: String,
    #[serde(default)]
    wait_for: Option<String>,
}

fn cf_backend_from_state(
    state: &Arc<AppState>,
    wait_for: Option<String>,
) -> Result<gctrl_net::CfBrowserBackend, axum::response::Response> {
    let account_id = state.net_config.cf_account_id.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "CF_ACCOUNT_ID not configured",
        )
            .into_response()
    })?;
    let api_token = state.net_config.cf_api_token.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "CF_API_TOKEN not configured",
        )
            .into_response()
    })?;
    Ok(gctrl_net::CfBrowserBackend::with_client(
        state.http_client.clone(),
        account_id,
        api_token,
        wait_for,
    ))
}

async fn net_render(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NetRenderBody>,
) -> impl IntoResponse {
    let backend = match cf_backend_from_state(&state, body.wait_for) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    match <gctrl_net::CfBrowserBackend as gctrl_net::RenderBackend>::render(&backend, &body.url)
        .await
    {
        Ok(rendered) => Json(serde_json::json!({
            "url": rendered.url,
            "status": rendered.status,
            "html": rendered.html,
        }))
        .into_response(),
        Err(e) => (net_error_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct NetScrapeBody {
    url: String,
    elements: Vec<gctrl_net::ScrapeElement>,
    #[serde(default)]
    wait_for: Option<String>,
}

async fn net_scrape(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NetScrapeBody>,
) -> impl IntoResponse {
    let backend = match cf_backend_from_state(&state, None) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    match backend
        .scrape(&body.url, body.elements, body.wait_for)
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => (net_error_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct NetScreenshotBody {
    url: String,
}

async fn net_screenshot(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NetScreenshotBody>,
) -> impl IntoResponse {
    let backend = match cf_backend_from_state(&state, None) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    match backend.screenshot(&body.url).await {
        Ok(b64) => Json(serde_json::json!({
            "url": body.url,
            "image_base64": b64,
            "format": "png",
        }))
        .into_response(),
        Err(e) => (net_error_status(&e), e.to_string()).into_response(),
    }
}

// --- Messaging Drivers (LKM — outbound to Telegram Bot API + Discord webhooks) ---

#[derive(Deserialize)]
struct TelegramSendBody {
    chat_id: String,
    text: String,
    #[serde(default)]
    disable_notification: bool,
}

#[derive(Deserialize)]
struct DiscordSendBody {
    webhook_url: String,
    content: String,
}

fn messaging_upstream_status(status: reqwest::StatusCode) -> StatusCode {
    match status.as_u16() {
        429 => StatusCode::TOO_MANY_REQUESTS,
        400 | 401 | 403 | 404 => StatusCode::BAD_REQUEST,
        s if s >= 500 => StatusCode::BAD_GATEWAY,
        _ => StatusCode::BAD_GATEWAY,
    }
}

async fn telegram_send(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TelegramSendBody>,
) -> impl IntoResponse {
    let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "TELEGRAM_BOT_TOKEN not configured",
        )
            .into_response();
    };
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let payload = serde_json::json!({
        "chat_id": body.chat_id,
        "text": body.text,
        "disable_notification": body.disable_notification,
    });
    match state.http_client.post(&url).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                let parsed: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                let message_id = parsed
                    .get("result")
                    .and_then(|r| r.get("message_id"))
                    .and_then(|m| m.as_i64());
                Json(serde_json::json!({
                    "ok": true,
                    "message_id": message_id,
                }))
                .into_response()
            } else {
                (messaging_upstream_status(status), text).into_response()
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("telegram request failed: {e}"),
        )
            .into_response(),
    }
}

async fn discord_send(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DiscordSendBody>,
) -> impl IntoResponse {
    if !body.webhook_url.starts_with("https://discord.com/api/webhooks/")
        && !body.webhook_url.starts_with("https://discordapp.com/api/webhooks/")
    {
        return (
            StatusCode::BAD_REQUEST,
            "webhook_url must be a discord.com/api/webhooks/... URL",
        )
            .into_response();
    }
    let payload = serde_json::json!({ "content": body.content });
    match state
        .http_client
        .post(&body.webhook_url)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                Json(serde_json::json!({ "ok": true })).into_response()
            } else {
                let text = resp.text().await.unwrap_or_default();
                (messaging_upstream_status(status), text).into_response()
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("discord request failed: {e}"),
        )
            .into_response(),
    }
}

// --- LLM Driver (LKM — outbound via Cloudflare AI Gateway) ---
//
// Forwards Anthropic-shape `/v1/messages` payloads through Cloudflare AI Gateway
// for centralized observability, caching, and optional managed provider keys.
//
// Required env:
//   CLOUDFLARE_ACCOUNT_ID        — CF account owning the gateway
//   CLOUDFLARE_AI_GATEWAY_ID     — slug of the AI Gateway
// At least one of:
//   ANTHROPIC_API_KEY                — BYOK mode, forwarded as `x-api-key`
//   CLOUDFLARE_AI_GATEWAY_TOKEN      — Authenticated-Gateway mode, forwarded as
//                                      `cf-aig-authorization: Bearer …`
//                                      (gateway injects its managed Anthropic
//                                      key — no Anthropic key needed locally)

async fn llm_messages(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Ok(account_id) = std::env::var("CLOUDFLARE_ACCOUNT_ID") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "CLOUDFLARE_ACCOUNT_ID not configured",
        )
            .into_response();
    };
    let Ok(gateway_id) = std::env::var("CLOUDFLARE_AI_GATEWAY_ID") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "CLOUDFLARE_AI_GATEWAY_ID not configured",
        )
            .into_response();
    };
    let anthropic_key = std::env::var("ANTHROPIC_API_KEY").ok();
    let gateway_token = std::env::var("CLOUDFLARE_AI_GATEWAY_TOKEN").ok();
    if anthropic_key.is_none() && gateway_token.is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "one of ANTHROPIC_API_KEY (BYOK) or CLOUDFLARE_AI_GATEWAY_TOKEN (managed) must be set",
        )
            .into_response();
    }
    let url = format!(
        "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages"
    );
    let mut req = state
        .http_client
        .post(&url)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    if let Some(k) = anthropic_key {
        req = req.header("x-api-key", k);
    }
    if let Some(t) = gateway_token {
        req = req.header("cf-aig-authorization", format!("Bearer {t}"));
    }
    match req.json(&body).send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(v) => Json(v).into_response(),
                    Err(_) => (StatusCode::BAD_GATEWAY, text).into_response(),
                }
            } else {
                (messaging_upstream_status(status), text).into_response()
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("ai gateway request failed: {e}"),
        )
            .into_response(),
    }
}

// --- LLM Driver: Workers AI (OpenAI-compat Chat Completions) ---
//
// Forwards OpenAI-shape Chat Completions payloads through Cloudflare AI Gateway
// to Cloudflare Workers AI models (e.g. `@cf/google/gemma-4-26b-a4b-it`).
//
// Required env:
//   CLOUDFLARE_ACCOUNT_ID        — CF account owning the gateway
//   CLOUDFLARE_AI_GATEWAY_ID     — slug of the AI Gateway
//   CF_API_TOKEN                 — Cloudflare API token with Workers AI read
//                                  scope, forwarded as `Authorization: Bearer …`

async fn llm_completions(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Ok(account_id) = std::env::var("CLOUDFLARE_ACCOUNT_ID") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "CLOUDFLARE_ACCOUNT_ID not configured",
        )
            .into_response();
    };
    let Ok(gateway_id) = std::env::var("CLOUDFLARE_AI_GATEWAY_ID") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "CLOUDFLARE_AI_GATEWAY_ID not configured",
        )
            .into_response();
    };
    let Ok(api_token) = std::env::var("CF_API_TOKEN") else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "CF_API_TOKEN not configured",
        )
            .into_response();
    };
    let url = format!(
        "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/v1/chat/completions"
    );
    let req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {api_token}"));
    match req.json(&body).send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(v) => Json(v).into_response(),
                    Err(_) => (StatusCode::BAD_GATEWAY, text).into_response(),
                }
            } else {
                (messaging_upstream_status(status), text).into_response()
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("ai gateway request failed: {e}"),
        )
            .into_response(),
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
    async fn test_sync_push_returns_503_when_unconfigured() {
        let app = test_app();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_sync_push_no_body_returns_503_when_unconfigured() {
        let app = test_app();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Build a router with a configured-but-fake SyncConfig. The fake creds
    /// would fail if the handler reached the D1 API, so any test using this
    /// must only touch code paths that short-circuit before the network.
    fn test_app_with_sync() -> Router {
        let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let sqlite = Arc::new(SqliteStore::open(":memory:").expect("sqlite open"));
        let sync_config = Arc::new(SyncConfig {
            d1_database_id: "test-db-id".into(),
            d1_account_id: "test-account-id".into(),
            d1_api_token: "test-token".into(),
            device_id: "test-device".into(),
            ..SyncConfig::default()
        });
        create_router_dual_with_sync(store, sqlite, Some(sync_config))
    }

    #[tokio::test]
    async fn test_sync_push_empty_body_defaults_to_sqlite_tables() {
        // Regression: empty `{}` previously expanded to every syncable table
        // including DuckDB ones (sessions/spans), which the throwaway in-memory
        // DuckDB has no schema for — handler returned 500 "Catalog Error: Table
        // with name sessions does not exist". Fix: default empty body to the
        // SQLite-only table set.
        let app = test_app_with_sync();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_rows"], 0);
    }

    #[tokio::test]
    async fn test_sync_push_no_body_defaults_to_sqlite_tables() {
        // Same regression, no body at all (not even `{}`). `Option<Json<...>>`
        // resolves to None → handler uses the default SQLite-only set.
        let app = test_app_with_sync();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_rows"], 0);
    }

    #[tokio::test]
    async fn test_sync_push_empty_sqlite_returns_zero_rows() {
        // Configured sync + empty SQLite + explicit board tables → short-circuits
        // inside push_table_to_d1 (list_unsynced_*.is_empty()) before any D1 call.
        let app = test_app_with_sync();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"tables":["board_projects","board_issues","board_comments","board_events"]}"#,
            ))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_rows"], 0);
        assert!(json["tables"].as_array().unwrap().is_empty());
        assert!(json["files"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_sync_push_tables_filter_scopes_to_requested() {
        // Passing only "board_projects" must not trigger a push for the other
        // three board tables — short-circuits on empty list_unsynced_projects.
        let app = test_app_with_sync();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"tables":["board_projects"]}"#))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total_rows"], 0);
    }

    #[tokio::test]
    async fn test_sync_push_malformed_json_returns_4xx() {
        // axum's default Json extractor rejects invalid JSON with 4xx before
        // the handler runs. Documents the contract for frontend callers.
        let app = test_app_with_sync();
        let req = Request::builder()
            .method("POST")
            .uri("/api/sync/push")
            .header("content-type", "application/json")
            .body(Body::from("{not json"))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert!(
            resp.status().is_client_error(),
            "expected 4xx, got {}",
            resp.status()
        );
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
        let req = Request::builder()
            .uri("/api/analytics/cost")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["by_model"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_analytics_latency_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/analytics/latency")
            .body(Body::empty())
            .unwrap();
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
        store
            .insert_score(&gctrl_core::Score {
                id: "s1".into(),
                target_type: "session".into(),
                target_id: "sess1".into(),
                name: "tests_pass".into(),
                value: 1.0,
                comment: None,
                source: "auto".into(),
                scored_by: None,
                created_at: chrono::Utc::now(),
            })
            .unwrap();

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
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
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
        store
            .insert_session(&gctrl_core::Session {
                id: gctrl_core::SessionId("s1".into()),
                workspace_id: gctrl_core::WorkspaceId("ws1".into()),
                device_id: gctrl_core::DeviceId("dev1".into()),
                agent_name: "claude".into(),
                started_at: chrono::Utc::now(),
                ended_at: None,
                status: gctrl_core::SessionStatus::Active,
                total_cost_usd: 0.0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                created_by: gctrl_core::CreatedBy::Unknown,
            })
            .unwrap();

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

    // --- Persona endpoint tests ---

    #[tokio::test]
    async fn test_persona_list_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/personas")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_persona_seed_and_list() {
        let app = test_app();

        // POST /api/personas/seed with 2 personas
        let seed_body = serde_json::json!({
            "personas": [
                {
                    "id": "engineer",
                    "name": "Engineer",
                    "focus": "code quality",
                    "prompt_prefix": "You are an engineer."
                },
                {
                    "id": "architect",
                    "name": "Architect",
                    "focus": "system design",
                    "prompt_prefix": "You are an architect."
                }
            ]
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/personas/seed")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&seed_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["created"], 2);

        // GET /api/personas
        let req = Request::builder()
            .uri("/api/personas")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json.as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_persona_get_not_found() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/personas/nonexistent")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_team_recommend_empty() {
        let app = test_app();
        let body = serde_json::json!({
            "labels": ["backend", "api"]
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/team/recommend")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["personas"].as_array().unwrap().is_empty());
    }

    // --- Inbox endpoint tests ---

    /// Helper to create an inbox message and return its ID.
    async fn create_test_message(app: &Router, title: &str) -> String {
        let msg_body = serde_json::json!({
            "source": "test-agent",
            "kind": "permission_request",
            "urgency": "high",
            "title": title,
            "body": "Please approve this action",
            "context_type": "session",
            "context_ref": "sess-001",
            "thread_title": "Test thread"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/messages")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&msg_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        json["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn test_inbox_list_messages_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/inbox/messages")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_inbox_create_message_and_get() {
        let app = test_app();

        // Create message
        let msg_id = create_test_message(&app, "Approve deploy").await;

        // GET /api/inbox/messages/{id}
        let req = Request::builder()
            .uri(format!("/api/inbox/messages/{}", msg_id))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["id"], msg_id);
        assert_eq!(json["title"], "Approve deploy");
        assert_eq!(json["status"], "pending");
        // Verify thread was auto-created
        assert!(json["thread_id"].as_str().is_some());
        let thread_id = json["thread_id"].as_str().unwrap();
        assert!(!thread_id.is_empty());
    }

    #[tokio::test]
    async fn test_inbox_create_message_invalid_kind() {
        let app = test_app();
        let msg_body = serde_json::json!({
            "source": "test-agent",
            "kind": "invalid",
            "title": "Bad kind",
            "context_type": "session",
            "context_ref": "sess-001"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/messages")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&msg_body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_inbox_create_message_invalid_urgency() {
        let app = test_app();
        let msg_body = serde_json::json!({
            "source": "test-agent",
            "kind": "permission_request",
            "urgency": "invalid",
            "title": "Bad urgency",
            "context_type": "session",
            "context_ref": "sess-001"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/messages")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&msg_body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_inbox_create_action_on_pending() {
        let app = test_app();

        // Create a pending message
        let msg_id = create_test_message(&app, "Approve action").await;

        // POST /api/inbox/actions to approve
        let action_body = serde_json::json!({
            "message_id": msg_id,
            "action_type": "approve",
            "reason": "Looks good"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/actions")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&action_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["action_type"], "approve");
        assert_eq!(json["message_id"], msg_id);

        // Verify message status changed to "acted"
        let req = Request::builder()
            .uri(format!("/api/inbox/messages/{}", msg_id))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "acted");
    }

    #[tokio::test]
    async fn test_inbox_create_action_on_acted_returns_conflict() {
        let app = test_app();

        // Create and approve a message
        let msg_id = create_test_message(&app, "Approve once").await;

        let action_body = serde_json::json!({
            "message_id": msg_id,
            "action_type": "approve"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/actions")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&action_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Try to approve again → 409
        let action_body = serde_json::json!({
            "message_id": msg_id,
            "action_type": "approve"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/actions")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&action_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_inbox_create_action_invalid_type() {
        let app = test_app();

        let action_body = serde_json::json!({
            "message_id": "some-id",
            "action_type": "invalid"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/actions")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&action_body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_inbox_batch_action() {
        let app = test_app();

        // Create 3 messages
        let id1 = create_test_message(&app, "Msg 1").await;
        let id2 = create_test_message(&app, "Msg 2").await;
        let _id3 = create_test_message(&app, "Msg 3").await;

        // Batch-approve 2
        let batch_body = serde_json::json!({
            "message_ids": [id1, id2],
            "action_type": "approve",
            "reason": "Batch approved"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/batch-action")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&batch_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let results = json["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["result"], "success");
        assert_eq!(results[1]["result"], "success");
    }

    #[tokio::test]
    async fn test_inbox_batch_action_size_limit() {
        let app = test_app();

        // Build 101 IDs
        let ids: Vec<String> = (0..101).map(|i| format!("msg-{}", i)).collect();
        let batch_body = serde_json::json!({
            "message_ids": ids,
            "action_type": "approve"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/batch-action")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&batch_body).unwrap()))
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_inbox_stats_empty() {
        let app = test_app();
        let req = Request::builder()
            .uri("/api/inbox/stats")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["total"], 0);
        assert_eq!(json["pending"], 0);
        assert_eq!(json["acted"], 0);
    }

    #[tokio::test]
    async fn test_inbox_get_thread_with_messages() {
        let app = test_app();

        // Create two messages in the same thread (same context_type + context_ref)
        let msg_body1 = serde_json::json!({
            "source": "agent-a",
            "kind": "permission_request",
            "urgency": "high",
            "title": "First message",
            "context_type": "session",
            "context_ref": "shared-session",
            "thread_title": "Shared thread"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/messages")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&msg_body1).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let msg1: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let thread_id = msg1["thread_id"].as_str().unwrap().to_string();

        let msg_body2 = serde_json::json!({
            "source": "agent-b",
            "kind": "status_update",
            "urgency": "low",
            "title": "Second message",
            "context_type": "session",
            "context_ref": "shared-session",
            "thread_title": "Shared thread"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/inbox/messages")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&msg_body2).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // GET /api/inbox/threads/{id}
        let req = Request::builder()
            .uri(format!("/api/inbox/threads/{}", thread_id))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["id"], thread_id);
        assert!(json["messages"].is_array());
        assert_eq!(json["messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_parse_wrangler_whoami_extracts_email_and_accounts() {
        let stdout = "\
 ⛅️ wrangler 4.80.0
-------------------
Getting User settings...
👋 You are logged in with an API Token, associated with the email 'dev@example.com'!
┌──────────────────────────┬──────────────────────────────────┐
│ Account Name             │ Account ID                       │
├──────────────────────────┼──────────────────────────────────┤
│ Acme Labs                │ abc123def456                     │
├──────────────────────────┼──────────────────────────────────┤
│ Personal                 │ 9876543210fedcba                 │
└──────────────────────────┴──────────────────────────────────┘
🔓 Token Permissions: workers:write, d1:write
";
        let parsed = parse_wrangler_whoami(stdout);
        assert_eq!(parsed["email"], "dev@example.com");
        let accounts = parsed["accounts"].as_array().expect("accounts array");
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0]["name"], "Acme Labs");
        assert_eq!(accounts[0]["id"], "abc123def456");
        assert_eq!(accounts[1]["name"], "Personal");
        assert_eq!(accounts[1]["id"], "9876543210fedcba");
        assert_eq!(parsed["raw"], stdout);
    }

    #[test]
    fn test_parse_wrangler_whoami_no_accounts() {
        // Logged in but no accounts resolved (API token with limited scope).
        let stdout = "\
Getting User settings...
👋 You are logged in with an API Token, associated with the email 'ci@example.com'!
";
        let parsed = parse_wrangler_whoami(stdout);
        assert_eq!(parsed["email"], "ci@example.com");
        assert!(parsed["accounts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_parse_wrangler_whoami_logged_out() {
        // `wrangler whoami` when not logged in — no email, no accounts.
        let stdout = "You are not authenticated. Please run `wrangler login`.\n";
        let parsed = parse_wrangler_whoami(stdout);
        assert!(parsed["email"].is_null());
        assert!(parsed["accounts"].as_array().unwrap().is_empty());
    }

    /// Use a binary that's guaranteed present on POSIX + CI runners so we can
    /// exercise the passthrough envelope without depending on `wrangler`/`gh`.
    #[tokio::test]
    async fn test_cli_exec_success_envelope() {
        let body = CliExecBody {
            args: vec!["hello from cli_exec".to_string()],
            cwd: None,
        };
        let resp = cli_exec("echo", body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json["stdout"]
            .as_str()
            .unwrap()
            .contains("hello from cli_exec"));
        assert_eq!(json["exitCode"], 0);
        assert!(json["durationMs"].is_number());
    }

    #[tokio::test]
    async fn test_cli_exec_nonzero_exit_still_200() {
        // `false` exits 1 without spawning failure — envelope should carry the code.
        let body = CliExecBody {
            args: vec![],
            cwd: None,
        };
        let resp = cli_exec("false", body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["exitCode"], 1);
    }

    #[tokio::test]
    async fn test_cli_exec_missing_binary_502() {
        let body = CliExecBody {
            args: vec![],
            cwd: None,
        };
        let resp = cli_exec("gctrl-definitely-not-a-binary-xyz", body).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn test_wrangler_exec_route_accepts_post() {
        let app = test_app();
        let body = serde_json::json!({ "args": ["--version"] });
        let req = Request::builder()
            .method("POST")
            .uri("/api/wrangler/exec")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        // 200 if wrangler is installed on the test host; 502 if not. Either
        // means the route wired up correctly — we only assert it's not a 404
        // or 405.
        assert!(
            resp.status() == StatusCode::OK || resp.status() == StatusCode::BAD_GATEWAY,
            "unexpected status {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn test_gh_exec_route_accepts_post() {
        let app = test_app();
        let body = serde_json::json!({ "args": ["--version"] });
        let req = Request::builder()
            .method("POST")
            .uri("/api/github/exec")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert!(
            resp.status() == StatusCode::OK || resp.status() == StatusCode::BAD_GATEWAY,
            "unexpected status {}",
            resp.status()
        );
    }

    // --- Contributions inference (M5, gctrl-analytics §4) ---

    fn fixture_session(id: &str, prov: gctrl_core::CreatedBy) -> gctrl_core::Session {
        gctrl_core::Session {
            id: gctrl_core::SessionId(id.into()),
            workspace_id: gctrl_core::WorkspaceId("ws".into()),
            device_id: gctrl_core::DeviceId("dev".into()),
            agent_name: "claude-code".into(),
            started_at: chrono::Utc::now(),
            ended_at: None,
            status: gctrl_core::SessionStatus::Active,
            total_cost_usd: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            created_by: prov,
        }
    }

    #[test]
    fn contribution_row_joins_trailer_to_session() {
        let sid = "11111111-2222-3333-4444-555555555555";
        let pr = serde_json::json!({
            "number": 42,
            "title": "feat: thing",
            "body": format!("subject\n\nbody\n\nSession-Id: {sid}\n"),
            "author": {"login": "bot"},
            "state": "MERGED",
            "url": "https://example.com/pulls/42",
            "headRefName": "feat/x",
            "mergedAt": "2026-04-27T00:00:00Z",
            "createdAt": "2026-04-26T00:00:00Z",
        });
        let row = build_contribution_row(&pr, |id| {
            (id == sid).then(|| fixture_session(sid, gctrl_core::CreatedBy::Api))
        });
        assert_eq!(row["session_id"], serde_json::json!(sid));
        assert_eq!(row["session_agent"], serde_json::json!("claude-code"));
        assert_eq!(row["created_by"], serde_json::json!("api"));
        assert_eq!(row["author"], serde_json::json!("bot"));
        assert_eq!(row["type"], serde_json::json!("pr"));
    }

    #[test]
    fn contribution_row_keeps_unattributed_rows() {
        // Spec invariant: missing trailer = unattributed, still shown.
        let pr = serde_json::json!({
            "number": 1,
            "title": "chore: untrailed",
            "body": "no trailer here",
            "author": {"login": "human"},
            "state": "OPEN",
            "url": "https://example.com/pulls/1",
            "headRefName": "main",
            "mergedAt": serde_json::Value::Null,
            "createdAt": "2026-04-25T00:00:00Z",
        });
        let row = build_contribution_row(&pr, |_| None);
        assert!(row["session_id"].is_null());
        assert!(row["session_agent"].is_null());
        assert!(row["created_by"].is_null());
    }

    #[test]
    fn contribution_row_drops_session_meta_when_session_missing() {
        // Trailer points at a session that no longer exists locally —
        // we still surface the trailer's id so operators can debug,
        // but session_meta is null.
        let sid = "deadbeef-2222-3333-4444-555555555555";
        let pr = serde_json::json!({
            "number": 7,
            "title": "feat: ghost",
            "body": format!("Session-Id: {sid}\n"),
            "author": {"login": "bot"},
            "state": "OPEN",
            "url": "https://example.com/pulls/7",
            "headRefName": "x",
            "mergedAt": serde_json::Value::Null,
            "createdAt": "2026-04-25T00:00:00Z",
        });
        let row = build_contribution_row(&pr, |_| None);
        assert_eq!(row["session_id"], serde_json::json!(sid));
        assert!(row["session_agent"].is_null());
        assert!(row["created_by"].is_null());
    }

    #[test]
    fn filter_drops_unattributed_when_kind_set() {
        let row = serde_json::json!({"created_by": serde_json::Value::Null});
        let filter: &[gctrl_core::CreatedBy] = &[gctrl_core::CreatedBy::OtelIngest];
        assert!(!contribution_passes_filter(&row, Some(filter)));
        // No filter ⇒ keep unattributed rows.
        assert!(contribution_passes_filter(&row, None));
    }

    #[test]
    fn filter_matches_internal_set() {
        let row = serde_json::json!({"created_by": "api"});
        let filter: &[gctrl_core::CreatedBy] =
            &[gctrl_core::CreatedBy::Scheduler, gctrl_core::CreatedBy::Api];
        assert!(contribution_passes_filter(&row, Some(filter)));

        let row_otel = serde_json::json!({"created_by": "otel_ingest"});
        assert!(!contribution_passes_filter(&row_otel, Some(filter)));
    }

    #[test]
    fn commit_row_extracts_subject_and_trailer() {
        let sid = "11111111-2222-3333-4444-555555555555";
        let commit = serde_json::json!({
            "sha": "abcdef1234567890",
            "html_url": "https://github.com/o/r/commit/abcdef1",
            "commit": {
                "message": format!(
                    "feat: add thing\n\nLong body explaining why.\n\nSession-Id: {sid}\n",
                ),
                "author": { "name": "Bot Bot", "date": "2026-04-26T12:00:00Z" }
            },
            "author": { "login": "bot-bot" }
        });
        let row = build_commit_row(&commit, |id| {
            (id == sid).then(|| fixture_session(sid, gctrl_core::CreatedBy::Scheduler))
        });
        assert_eq!(row["type"], serde_json::json!("commit"));
        assert_eq!(row["sha"], serde_json::json!("abcdef1234567890"));
        assert_eq!(row["title"], serde_json::json!("feat: add thing"));
        assert_eq!(row["author"], serde_json::json!("Bot Bot"));
        assert_eq!(row["session_id"], serde_json::json!(sid));
        assert_eq!(row["created_by"], serde_json::json!("scheduler"));
        assert_eq!(row["state"], serde_json::json!("merged"));
        assert_eq!(row["created_at"], serde_json::json!("2026-04-26T12:00:00Z"));
    }

    #[test]
    fn resolve_since_handles_relative_days() {
        use chrono::TimeZone;
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 4, 27, 12, 0, 0)
            .unwrap();
        assert_eq!(resolve_since("7d", now), Some("2026-04-20".into()));
        assert_eq!(resolve_since("30d", now), Some("2026-03-28".into()));
        assert_eq!(resolve_since("  90d  ", now), Some("2026-01-27".into()));
    }

    #[test]
    fn resolve_since_handles_absolute_date() {
        let now = chrono::Utc::now();
        assert_eq!(
            resolve_since("2026-04-01", now),
            Some("2026-04-01".into()),
        );
    }

    #[test]
    fn resolve_since_returns_none_for_invalid_input() {
        let now = chrono::Utc::now();
        assert_eq!(resolve_since("", now), None);
        assert_eq!(resolve_since("yesterday", now), None);
        assert_eq!(resolve_since("0d", now), None); // zero days = no window
        assert_eq!(resolve_since("-3d", now), None); // negative = invalid
        assert_eq!(resolve_since("2026/04/01", now), None); // wrong separator
    }

    #[test]
    fn commit_row_falls_back_to_author_login() {
        // Commits authored via the GitHub web UI sometimes have a
        // different `commit.author.name` ("GitHub") and a richer
        // `author.login` — our fallback prefers commit.author.name
        // when present, but uses author.login when name is missing.
        let commit = serde_json::json!({
            "sha": "deadbeef",
            "html_url": "https://example.com/c/deadbeef",
            "commit": {
                "message": "subject\n\nbody\n",
                "author": { "date": "2026-04-25T08:00:00Z" }
            },
            "author": { "login": "web-ui-user" }
        });
        let row = build_commit_row(&commit, |_| None);
        assert_eq!(row["author"], serde_json::json!("web-ui-user"));
        assert!(row["session_id"].is_null());
    }
}
