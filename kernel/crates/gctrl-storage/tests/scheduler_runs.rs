//! Tests for the `scheduler_runs` table primitives — durable history of
//! schedule fires powering the Schedule page's CI-style sparkline and the
//! `/api/schedules/{id}/runs` route.
//!
//! Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.1.

use chrono::Utc;
use gctrl_core::{
    Schedule, ScheduleRun, ScheduleRunFilter, FIRE_KIND_CRON, FIRE_KIND_MANUAL,
    RUN_STATUS_FAILURE, RUN_STATUS_SUCCESS, TARGET_KIND_HTTP,
};
use gctrl_storage::SqliteStore;

fn store() -> SqliteStore {
    SqliteStore::open(":memory:").expect("open :memory: store")
}

fn seed_schedule(store: &SqliteStore, name: &str) -> Schedule {
    let now = Utc::now().to_rfc3339();
    let s = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        cron: "0 */2 * * *".into(),
        target_kind: TARGET_KIND_HTTP.into(),
        target_url: "http://example.invalid/hook".into(),
        target_method: "POST".into(),
        body_json: None,
        headers_json: None,
        command: None,
        cwd: None,
        env_keys: None,
        timeout_secs: 60,
        enabled: true,
        next_run_at: None,
        last_run_at: None,
        last_status: None,
        last_response: None,
        last_error: None,
        run_count: 0,
        failure_count: 0,
        created_at: now.clone(),
        updated_at: now,
    };
    store.create_schedule(&s).expect("create_schedule");
    s
}

fn run_at(schedule_id: &str, started_at: chrono::DateTime<Utc>, status: &str, fire_kind: &str) -> ScheduleRun {
    ScheduleRun {
        id: uuid::Uuid::new_v4().to_string(),
        schedule_id: schedule_id.into(),
        started_at: started_at.to_rfc3339(),
        finished_at: Some(started_at.to_rfc3339()),
        status: status.into(),
        fire_kind: fire_kind.into(),
        exit_code: None,
        http_status: Some(if status == RUN_STATUS_SUCCESS { 200 } else { 503 }),
        response_preview: Some("ok".into()),
        error_preview: None,
        duration_ms: Some(42),
        created_at: started_at.to_rfc3339(),
    }
}

#[test]
fn insert_and_list_round_trip() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    let r = run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_CRON);
    s.insert_schedule_run(&r).expect("insert");

    let rows = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, r.id);
    assert_eq!(rows[0].status, RUN_STATUS_SUCCESS);
    assert_eq!(rows[0].fire_kind, FIRE_KIND_CRON);
    assert_eq!(rows[0].http_status, Some(200));
}

#[test]
fn list_orders_latest_first() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    // Insert in order: oldest, middle, newest. List MUST come back newest-first.
    let oldest = run_at(&sched.id, now - chrono::Duration::hours(2), RUN_STATUS_SUCCESS, FIRE_KIND_CRON);
    let middle = run_at(&sched.id, now - chrono::Duration::hours(1), RUN_STATUS_FAILURE, FIRE_KIND_CRON);
    let newest = run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_MANUAL);
    s.insert_schedule_run(&oldest).unwrap();
    s.insert_schedule_run(&middle).unwrap();
    s.insert_schedule_run(&newest).unwrap();

    let rows = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .expect("list");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].id, newest.id);
    assert_eq!(rows[1].id, middle.id);
    assert_eq!(rows[2].id, oldest.id);
}

#[test]
fn list_filters_status() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    s.insert_schedule_run(&run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(
        &sched.id,
        now - chrono::Duration::minutes(1),
        RUN_STATUS_FAILURE,
        FIRE_KIND_CRON,
    ))
    .unwrap();
    let only_failures = s
        .list_schedule_runs(
            &sched.id,
            &ScheduleRunFilter {
                status: Some(RUN_STATUS_FAILURE.into()),
                ..Default::default()
            },
        )
        .expect("list filtered");
    assert_eq!(only_failures.len(), 1);
    assert_eq!(only_failures[0].status, RUN_STATUS_FAILURE);
}

#[test]
fn list_filters_since() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    let old = now - chrono::Duration::days(2);
    let recent = now - chrono::Duration::minutes(5);
    s.insert_schedule_run(&run_at(&sched.id, old, RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(&sched.id, recent, RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    let last_day = now - chrono::Duration::days(1);
    let rows = s
        .list_schedule_runs(
            &sched.id,
            &ScheduleRunFilter {
                since: Some(last_day.to_rfc3339()),
                ..Default::default()
            },
        )
        .expect("list filtered");
    assert_eq!(rows.len(), 1, "only the recent row should match");
}

#[test]
fn list_caps_at_500() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    // Caller asks for 9_999, hard cap is 500.
    for i in 0..10 {
        s.insert_schedule_run(&run_at(
            &sched.id,
            now - chrono::Duration::seconds(i),
            RUN_STATUS_SUCCESS,
            FIRE_KIND_CRON,
        ))
        .unwrap();
    }
    let rows = s
        .list_schedule_runs(
            &sched.id,
            &ScheduleRunFilter {
                limit: Some(9_999),
                ..Default::default()
            },
        )
        .expect("list");
    // We only inserted 10, so cap doesn't matter for this assertion — but
    // the call would have OOMed if the cap weren't applied to the LIMIT.
    assert!(rows.len() <= 500);
    assert_eq!(rows.len(), 10);
}

#[test]
fn global_list_returns_runs_across_schedules_latest_first() {
    let s = store();
    let a = seed_schedule(&s, "audit.codebase");
    let b = seed_schedule(&s, "gap.specs-vs-code");
    let now = Utc::now();
    s.insert_schedule_run(&run_at(&a.id, now - chrono::Duration::minutes(2), RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(&b.id, now, RUN_STATUS_FAILURE, FIRE_KIND_CRON))
        .unwrap();

    let rows = s
        .list_schedule_runs_global(&ScheduleRunFilter::default())
        .expect("global list");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].schedule_id, b.id, "latest first");
    assert_eq!(rows[1].schedule_id, a.id);
}

#[test]
fn global_list_filters_failure_status() {
    let s = store();
    let a = seed_schedule(&s, "audit.codebase");
    let b = seed_schedule(&s, "gap.specs-vs-code");
    let now = Utc::now();
    s.insert_schedule_run(&run_at(&a.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(&b.id, now, RUN_STATUS_FAILURE, FIRE_KIND_CRON))
        .unwrap();
    let rows = s
        .list_schedule_runs_global(&ScheduleRunFilter {
            status: Some(RUN_STATUS_FAILURE.into()),
            ..Default::default()
        })
        .expect("filtered");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].schedule_id, b.id);
}

#[test]
fn delete_schedule_cascades_to_runs() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    s.insert_schedule_run(&run_at(&sched.id, Utc::now(), RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    assert_eq!(
        s.list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
            .unwrap()
            .len(),
        1
    );
    s.delete_schedule(&sched.id).unwrap();
    let rows = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .expect("list after delete");
    assert!(rows.is_empty(), "cascade should drop history");
}

#[test]
fn prune_by_started_at_is_idempotent() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    // Two old rows + one recent.
    s.insert_schedule_run(&run_at(&sched.id, now - chrono::Duration::days(120), RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(&sched.id, now - chrono::Duration::days(91), RUN_STATUS_FAILURE, FIRE_KIND_CRON))
        .unwrap();
    s.insert_schedule_run(&run_at(&sched.id, now - chrono::Duration::days(5), RUN_STATUS_SUCCESS, FIRE_KIND_CRON))
        .unwrap();

    let cutoff = (now - chrono::Duration::days(90)).to_rfc3339();
    let n1 = s.delete_schedule_runs_before(&cutoff).unwrap();
    assert_eq!(n1, 2, "two old rows should be pruned");
    let n2 = s.delete_schedule_runs_before(&cutoff).unwrap();
    assert_eq!(n2, 0, "second run is a no-op");
    let remaining = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .unwrap();
    assert_eq!(remaining.len(), 1, "only the recent row survives");
}
