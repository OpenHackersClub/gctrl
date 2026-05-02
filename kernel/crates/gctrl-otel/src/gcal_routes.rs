//! Google Calendar driver HTTP routes.
//!
//! Mounts `/api/gcal/*` onto the kernel router. Credentials come from the
//! environment (`GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`, `GCAL_REFRESH_TOKEN`)
//! and are loaded lazily on first use; if any are missing, every route
//! returns 503 so callers see a clear "driver offline" signal instead of a
//! configuration crash.
//!
//! Permissions are gated by `GCAL_ALLOWED_SCOPES` (comma-separated; default
//! `read`). Mutations require `write`. Deletion is intentionally not
//! mounted — there is no DELETE handler at all so there is no flag that
//! can flip it on.

use std::sync::{Arc, OnceLock};

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use gctrl_gcal::{EventInput, GcalClient, GcalCredentials, GcalError};
use serde::Deserialize;
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Read,
    Write,
}

fn allowed_scopes() -> Vec<Scope> {
    static CACHED: OnceLock<Vec<Scope>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            std::env::var("GCAL_ALLOWED_SCOPES")
                .ok()
                .map(|raw| {
                    raw.split(',')
                        .map(|s| s.trim().to_lowercase())
                        .filter(|s| !s.is_empty())
                        .filter_map(|s| match s.as_str() {
                            "read" => Some(Scope::Read),
                            "write" => Some(Scope::Write),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_else(|| vec![Scope::Read])
        })
        .clone()
}

fn require_scope(scope: Scope) -> Result<(), (StatusCode, String)> {
    if allowed_scopes().contains(&scope) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            format!(
                "gcal permission denied: scope `{}` not in GCAL_ALLOWED_SCOPES",
                match scope {
                    Scope::Read => "read",
                    Scope::Write => "write",
                }
            ),
        ))
    }
}

async fn client() -> Result<Arc<GcalClient>, (StatusCode, String)> {
    static CELL: OnceCell<Option<Arc<GcalClient>>> = OnceCell::const_new();
    let opt = CELL
        .get_or_init(|| async {
            match GcalCredentials::from_env() {
                Ok(Some(creds)) => Some(Arc::new(GcalClient::new(reqwest::Client::new(), creds))),
                _ => None,
            }
        })
        .await
        .clone();
    opt.ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "gcal driver offline: set GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN".into(),
    ))
}

fn map_err(e: GcalError) -> (StatusCode, String) {
    match e {
        GcalError::MissingCredential(_) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()),
        GcalError::OauthRefresh(_) => (StatusCode::BAD_GATEWAY, e.to_string()),
        GcalError::Api { status, .. } => {
            let s = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            (s, e.to_string())
        }
        GcalError::Http(_) => (StatusCode::BAD_GATEWAY, e.to_string()),
        GcalError::Parse(_) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ListEventsQuery {
    #[serde(default)]
    calendar_id: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    max_results: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CalendarIdQuery {
    #[serde(default)]
    calendar_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateEventBody {
    #[serde(default)]
    calendar_id: Option<String>,
    #[serde(flatten)]
    event: EventInput,
}

fn calendar_id_or_default(id: Option<String>) -> String {
    id.filter(|s| !s.is_empty()).unwrap_or_else(|| "primary".to_string())
}

async fn list_calendars() -> impl IntoResponse {
    if let Err(e) = require_scope(Scope::Read) {
        return e.into_response();
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    match client.list_calendars().await {
        Ok(items) => Json(items).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

async fn list_events(Query(q): Query<ListEventsQuery>) -> impl IntoResponse {
    if let Err(e) = require_scope(Scope::Read) {
        return e.into_response();
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let cal = calendar_id_or_default(q.calendar_id);
    match client
        .list_events(&cal, q.from.as_deref(), q.to.as_deref(), q.max_results)
        .await
    {
        Ok(items) => Json(items).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

async fn get_event(
    Path(event_id): Path<String>,
    Query(q): Query<CalendarIdQuery>,
) -> impl IntoResponse {
    if let Err(e) = require_scope(Scope::Read) {
        return e.into_response();
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let cal = calendar_id_or_default(q.calendar_id);
    match client.get_event(&cal, &event_id).await {
        Ok(ev) => Json(ev).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

async fn create_event(Json(body): Json<CreateEventBody>) -> impl IntoResponse {
    if let Err(e) = require_scope(Scope::Write) {
        return e.into_response();
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let cal = calendar_id_or_default(body.calendar_id);
    match client.create_event(&cal, &body.event).await {
        Ok(ev) => (StatusCode::CREATED, Json(ev)).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

async fn patch_event(
    Path(event_id): Path<String>,
    Query(q): Query<CalendarIdQuery>,
    Json(input): Json<EventInput>,
) -> impl IntoResponse {
    if let Err(e) = require_scope(Scope::Write) {
        return e.into_response();
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let cal = calendar_id_or_default(q.calendar_id);
    match client.patch_event(&cal, &event_id, &input).await {
        Ok(ev) => Json(ev).into_response(),
        Err(e) => map_err(e).into_response(),
    }
}

/// Mount the gcal driver routes. DELETE is intentionally absent — adding it
/// is a deliberate, reviewable change rather than a flag flip.
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/gcal/calendars", get(list_calendars))
        .route("/api/gcal/events", get(list_events).post(create_event))
        .route("/api/gcal/events/{event_id}", get(get_event).patch(patch_event))
}
