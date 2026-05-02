//! End-to-end test of the runner: insert a due schedule pointing at a
//! `wiremock` stub, run one tick, assert the stub was hit and the row was
//! updated with status + recomputed `next_run_at`.

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use gctrl_core::{
    Schedule, ScheduleRunFilter, SchedulerConfig, FIRE_KIND_CRON, RUN_STATUS_FAILURE,
    RUN_STATUS_SUCCESS,
};
use gctrl_scheduler::ScheduleRunner;
use gctrl_storage::SqliteStore;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn make_due_schedule(target_url: &str) -> Schedule {
    let now = Utc::now();
    // next_run_at in the past → guaranteed due on next tick.
    let past = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
    Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: "test.due".into(),
        cron: "0 */2 * * *".into(),
        target_kind: gctrl_core::TARGET_KIND_HTTP.into(),
        target_url: target_url.into(),
        target_method: "POST".into(),
        body_json: Some(serde_json::json!({ "hello": "world" })),
        headers_json: None,
        command: None,
        cwd: None,
        env_keys: None,
        timeout_secs: 5,
        enabled: true,
        next_run_at: Some(past.to_rfc3339()),
        last_run_at: None,
        last_status: None,
        last_response: None,
        last_error: None,
        run_count: 0,
        failure_count: 0,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    }
}

#[tokio::test]
async fn runner_fires_due_schedule_and_records_outcome() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hook"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"ok":true}"#))
        .expect(1)
        .mount(&mock)
        .await;

    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let sched = make_due_schedule(&format!("{}/hook", mock.uri()));
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    let n = runner.tick().await.unwrap();
    assert_eq!(n, 1, "exactly one schedule should fire");

    let after = store.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.last_status, Some(200));
    assert_eq!(after.run_count, 1);
    assert_eq!(after.failure_count, 0);
    assert!(after.last_run_at.is_some());
    // Recomputed next_run_at must be in the future, not the historical past
    // value we seeded with.
    let next = after.next_run_at.expect("next_run_at recomputed");
    let next_dt: chrono::DateTime<Utc> = chrono::DateTime::parse_from_rfc3339(&next)
        .unwrap()
        .with_timezone(&Utc);
    assert!(next_dt > Utc::now());

    drop(mock); // verifies `expect(1)`.
}

#[tokio::test]
async fn runner_records_failure_on_5xx() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/boom"))
        .respond_with(ResponseTemplate::new(503).set_body_string("nope"))
        .mount(&mock)
        .await;

    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let sched = make_due_schedule(&format!("{}/boom", mock.uri()));
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    runner.tick().await.unwrap();

    let after = store.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.last_status, Some(503));
    assert_eq!(after.run_count, 1);
    assert_eq!(after.failure_count, 1, "5xx must increment failure_count");
}

#[tokio::test]
async fn runner_caps_huge_response_body() {
    // Target returns 256 KB; runner cap is 64 KB. Stored response must be
    // bounded — otherwise a misbehaving target could OOM the daemon.
    let big_body: String = "x".repeat(256 * 1024);
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/big"))
        .respond_with(ResponseTemplate::new(200).set_body_string(big_body))
        .mount(&mock)
        .await;

    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let sched = make_due_schedule(&format!("{}/big", mock.uri()));
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    runner.tick().await.unwrap();

    let after = store.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.last_status, Some(200));
    let stored = after.last_response.expect("response stored");
    // Preview cap (4 KB) is what actually lands in storage; the body cap
    // (64 KB) is what's read off the wire. The preview is well below either.
    assert!(stored.len() <= 8 * 1024, "stored len {}", stored.len());
}

#[tokio::test]
async fn runner_appends_scheduler_runs_row_on_success() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hook"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&mock)
        .await;

    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let sched = make_due_schedule(&format!("{}/hook", mock.uri()));
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    runner.tick().await.unwrap();

    let runs = store
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .expect("list runs");
    assert_eq!(runs.len(), 1, "exactly one history row per fire");
    let r = &runs[0];
    assert_eq!(r.status, RUN_STATUS_SUCCESS);
    assert_eq!(r.fire_kind, FIRE_KIND_CRON);
    assert_eq!(r.http_status, Some(200));
    assert!(r.exit_code.is_none(), "http rows do not set exit_code");
    assert!(r.duration_ms.unwrap() >= 0);
    assert!(r.finished_at.is_some(), "cron path always closes the row");
}

#[tokio::test]
async fn runner_appends_scheduler_runs_row_on_failure() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/boom"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&mock)
        .await;

    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    let sched = make_due_schedule(&format!("{}/boom", mock.uri()));
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    runner.tick().await.unwrap();

    let runs = store
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .expect("list runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, RUN_STATUS_FAILURE);
    assert_eq!(runs[0].http_status, Some(503));
}

#[tokio::test]
async fn runner_skips_non_due_schedules() {
    let store = Arc::new(SqliteStore::open(":memory:").unwrap());
    // Schedule whose next_run is far in the future.
    let mut sched = make_due_schedule("http://127.0.0.1:1");
    sched.next_run_at = Some(
        Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0)
            .unwrap()
            .to_rfc3339(),
    );
    store.create_schedule(&sched).unwrap();

    let runner = ScheduleRunner::new(Arc::clone(&store), SchedulerConfig::default());
    let n = runner.tick().await.unwrap();
    assert_eq!(n, 0);
    let after = store.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.run_count, 0);
}
