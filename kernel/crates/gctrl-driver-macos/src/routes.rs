// HTTP surface for `/api/macos/*`. Mounted by `gctrl-otel` alongside the
// other driver routes. The default build wires routes that work without
// real FFI: /health, /spaces (label-only), and the rename pipeline that
// persists into `macos_space_labels`. The /switch route is present but
// returns Unsupported until the FFI feature lands.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use async_stream::stream;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json,
    },
    routing::{get, post},
    Router,
};
use futures_core::Stream;
use gctrl_core::platform::{
    PermissionStatus, PlatformError, PlatformHealth, PlatformPort, PowerStatus,
    SleepPreventionKind, Space, SpaceEvent, SpaceId,
};
use gctrl_storage::DuckDbStore;
use serde::Deserialize;

use crate::{
    machine_id, permissions, primary_display_uuid, space_id_to_index, stub_space_for_label,
    PLACEHOLDER_SPACE_KIND,
};

#[derive(Clone)]
pub struct DriverState {
    pub driver: Arc<dyn PlatformPort>,
    pub store: Option<Arc<DuckDbStore>>,
    /// Optional handle to the FfiDriver's shared SpacesState so the
    /// SSE stream can subscribe to the live event channel. None on
    /// stub builds — the stream then echoes a heartbeat only.
    pub spaces_state: Option<Arc<crate::spaces::SpacesState>>,
}

pub fn router(state: DriverState) -> Router {
    Router::new()
        .route("/api/macos/health", get(health_handler))
        .route("/api/macos/spaces", get(list_spaces_handler))
        .route("/api/macos/spaces/current", get(current_space_handler))
        .route("/api/macos/spaces/stream", get(stream_handler))
        .route(
            "/api/macos/spaces/{id}/name",
            post(name_handler).delete(unname_handler),
        )
        .route("/api/macos/spaces/{id}/switch", post(switch_handler))
        .route(
            "/api/macos/permissions/accessibility/prompt",
            post(prompt_accessibility_handler),
        )
        // Power (prevent-sleep / "caffeinate"): GET status, POST to toggle.
        .route(
            "/api/macos/power",
            get(power_status_handler).post(set_power_handler),
        )
        .with_state(state)
}

async fn health_handler(State(state): State<DriverState>) -> Json<PlatformHealth> {
    Json(state.driver.health())
}

/// `GET /api/macos/power` — current prevent-sleep state. Always 200: on
/// builds without the capability it reports `supported: false`.
async fn power_status_handler(State(state): State<DriverState>) -> Json<PowerStatus> {
    let status = match state.driver.power() {
        Some(p) => p.status(),
        None => PowerStatus {
            supported: false,
            active: false,
            kind: SleepPreventionKind::default(),
            reason: String::new(),
        },
    };
    Json(status)
}

#[derive(Deserialize)]
struct SetPowerBody {
    /// Hold the assertion (`true`) or release it (`false`).
    enable: bool,
    /// Assertion type. Defaults to `display` (full Caffeine parity).
    #[serde(default)]
    kind: Option<SleepPreventionKind>,
    /// Reason surfaced in `pmset -g assertions`.
    #[serde(default)]
    reason: Option<String>,
}

/// `POST /api/macos/power` — toggle the prevent-sleep assertion. Returns the
/// new state, or `501` on builds without the power capability.
async fn set_power_handler(
    State(state): State<DriverState>,
    Json(body): Json<SetPowerBody>,
) -> impl IntoResponse {
    let Some(power) = state.driver.power() else {
        return map_error(PlatformError::Unsupported {
            what: "power capability unavailable".into(),
        });
    };
    let kind = body.kind.unwrap_or_default();
    let reason = body.reason.unwrap_or_default();
    match power.set_prevent_sleep(body.enable, kind, &reason) {
        Ok(status) => Json(status).into_response(),
        Err(err) => map_error(err),
    }
}

async fn list_spaces_handler(State(state): State<DriverState>) -> impl IntoResponse {
    // When the `spaces` capability is live the driver returns the real
    // Space list (combining CGS reads + stored labels). For now we
    // synthesize a Space-per-stored-label so the rest of the pipeline
    // (label CTA, settings panel preview) has data to render.
    if let Some(port) = state.driver.spaces() {
        return map_result(port.list());
    }
    let store = match &state.store {
        Some(s) => s,
        None => return Json::<Vec<Space>>(vec![]).into_response(),
    };
    match store.list_macos_labels(&machine_id(), None) {
        Ok(labels) => {
            let spaces: Vec<Space> = labels
                .iter()
                .map(|l| stub_space_for_label(l, false))
                .collect();
            Json(spaces).into_response()
        }
        Err(e) => internal_error(e.to_string()),
    }
}

async fn current_space_handler(State(state): State<DriverState>) -> impl IntoResponse {
    match state.driver.spaces() {
        Some(port) => match port.current() {
            Ok(space) => Json(space).into_response(),
            Err(err) => map_error(err),
        },
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "spaces capability unavailable",
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn name_handler(
    State(state): State<DriverState>,
    Path(id): Path<u64>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    let trimmed = body.name.trim();
    if trimmed.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "label cannot be empty" })),
        )
            .into_response();
    }
    let store = match &state.store {
        Some(s) => s,
        None => return service_unavailable("storage unavailable"),
    };
    let space_index = space_id_to_index(SpaceId(id));
    let row = gctrl_core::MacosSpaceLabel {
        machine_id: machine_id(),
        display_uuid: primary_display_uuid(),
        space_index,
        space_kind: PLACEHOLDER_SPACE_KIND.into(),
        label: trimmed.to_string(),
        cgs_id_hint: Some(id as i64),
        created_at: String::new(),
        updated_at: String::new(),
    };
    if let Err(e) = store.upsert_macos_label(&row) {
        return internal_error(e.to_string());
    }
    if let Some(spaces_state) = &state.spaces_state {
        let _ = spaces_state.events.send(SpaceEvent::Renamed {
            id: SpaceId(id),
            name: Some(trimmed.to_string()),
        });
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn unname_handler(
    State(state): State<DriverState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    let store = match &state.store {
        Some(s) => s,
        None => return service_unavailable("storage unavailable"),
    };
    let space_index = space_id_to_index(SpaceId(id));
    let display = primary_display_uuid();
    match store.delete_macos_label(
        &machine_id(),
        &display,
        space_index,
        PLACEHOLDER_SPACE_KIND,
    ) {
        Ok(true) => {
            if let Some(spaces_state) = &state.spaces_state {
                let _ = spaces_state
                    .events
                    .send(SpaceEvent::Renamed { id: SpaceId(id), name: None });
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => internal_error(e.to_string()),
    }
}

async fn switch_handler(
    State(state): State<DriverState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.driver.spaces() {
        Some(port) => match port.switch_to(SpaceId(id)) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(err) => map_error(err),
        },
        None => map_error(PlatformError::Unsupported {
            what: "spaces.switch_to (FFI feature not enabled)".into(),
        }),
    }
}

#[derive(serde::Serialize)]
struct PromptResponse {
    accessibility: PermissionStatus,
}

async fn prompt_accessibility_handler() -> Json<PromptResponse> {
    Json(PromptResponse {
        accessibility: permissions::prompt_ax(),
    })
}

/// SSE feed of `SpaceEvent`s. Subscribes to the FfiDriver's broadcast
/// channel when present; on stub builds it emits keepalives only so
/// the route shape stays consistent across feature flags.
async fn stream_handler(
    State(state): State<DriverState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.spaces_state.as_ref().map(|s| s.subscribe());
    let s = stream! {
        if let Some(rx) = rx.as_mut() {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let payload = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".into());
                        yield Ok(Event::default().event("space").data(payload));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        } else {
            // Stub build — keepalive only.
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            loop {
                interval.tick().await;
                yield Ok(Event::default().event("ping").data("{}"));
            }
        }
    };
    Sse::new(s).keep_alive(KeepAlive::default())
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

fn map_result<T: serde::Serialize>(r: Result<T, PlatformError>) -> axum::response::Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(err) => map_error(err),
    }
}

fn map_error(err: PlatformError) -> axum::response::Response {
    let status = match &err {
        PlatformError::PermissionDenied { .. } => StatusCode::FORBIDDEN,
        PlatformError::Unsupported { .. } => StatusCode::NOT_IMPLEMENTED,
        PlatformError::DisplayGone => StatusCode::GONE,
        PlatformError::VersionSkew { .. } => StatusCode::SERVICE_UNAVAILABLE,
        PlatformError::Underlying(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(serde_json::json!({ "error": err.to_string() }))).into_response()
}

fn internal_error(msg: String) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn service_unavailable(msg: &str) -> axum::response::Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StubDriver;
    use gctrl_storage::DuckDbStore;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app_with_store() -> (Router, Arc<DuckDbStore>) {
        let store = Arc::new(DuckDbStore::open(":memory:").unwrap());
        let app = router(DriverState {
            driver: Arc::new(StubDriver::new()),
            store: Some(Arc::clone(&store)),
            spaces_state: None,
        });
        (app, store)
    }

    fn app_no_store() -> Router {
        router(DriverState {
            driver: Arc::new(StubDriver::new()),
            store: None,
            spaces_state: None,
        })
    }

    #[tokio::test]
    async fn health_includes_accessibility_status() {
        let res = app_no_store()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/macos/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        // Default build → stub reports `not_requested`. With the `ffi`
        // feature on we get a real AX trust probe, which under cargo
        // test (a non-trusted binary) reports `denied` or, less
        // commonly, `granted`. Either way it's never `not_requested`.
        let ax = v["permissions"]["accessibility"].as_str().unwrap();
        if cfg!(all(feature = "ffi", target_os = "macos")) {
            assert!(matches!(ax, "granted" | "denied"), "got {ax}");
        } else {
            assert_eq!(ax, "not_requested");
        }
        assert_eq!(v["capabilities"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn list_spaces_returns_empty_on_empty_store() {
        let (app, _) = app_with_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/macos/spaces")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn name_persists_and_lists_back() {
        let (app, store) = app_with_store();

        // POST /api/macos/spaces/3/name { name: "inbox" }
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/macos/spaces/3/name")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"name":"inbox"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        // Confirm the row landed via the storage adapter.
        let labels = store.list_macos_labels(&machine_id(), None).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].label, "inbox");
        assert_eq!(labels[0].space_index, 3);

        // GET /api/macos/spaces echoes one Space synthesized from the row.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/macos/spaces")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "inbox");
        assert_eq!(arr[0]["index"], 3);
    }

    #[tokio::test]
    async fn name_rejects_empty_label() {
        let (app, _) = app_with_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/macos/spaces/1/name")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"name":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unname_404_when_missing() {
        let (app, _) = app_with_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri("/api/macos/spaces/99/name")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn switch_returns_not_implemented_on_stub() {
        let (app, _) = app_with_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/macos/spaces/1/switch")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn prompt_accessibility_returns_status() {
        // Note: with `ffi` enabled this would *actually* trigger the
        // system AX prompt under cargo test on macOS, which is annoying
        // to run unattended. Skip the prompt path under `ffi`; the stub
        // path covers the route's response shape.
        if cfg!(all(feature = "ffi", target_os = "macos")) {
            return;
        }
        let app = app_no_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/macos/permissions/accessibility/prompt")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["accessibility"], "not_requested");
    }

    #[tokio::test]
    async fn current_space_unavailable_on_stub() {
        let app = app_no_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/macos/spaces/current")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn power_status_reports_unsupported_on_stub() {
        // StubDriver advertises no power capability, so the route reports the
        // shape with supported:false rather than erroring.
        let app = app_no_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/macos/power")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["supported"], false);
        assert_eq!(v["active"], false);
        assert_eq!(v["kind"], "display");
    }

    #[tokio::test]
    async fn set_power_returns_not_implemented_on_stub() {
        let app = app_no_store();
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/macos/power")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"enable":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
