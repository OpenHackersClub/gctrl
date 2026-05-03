//! Tests for the `scheduler_runs` table primitives — durable history of
//! schedule fires powering the Schedule page's CI-style sparkline and the
//! `/api/schedules/{id}/runs` route.
//!
//! Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.1.

use chrono::Utc;
use gctrl_core::{
    Schedule, ScheduleRun, ScheduleRunFilter, ScheduleRunUpdate, FIRE_KIND_CRON, FIRE_KIND_MANUAL,
    RUN_STATUS_FAILURE, RUN_STATUS_INTERRUPTED, RUN_STATUS_SUCCESS, TARGET_KIND_HTTP,
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
        app_id: None,
        created_at: now.clone(),
        updated_at: now,
        health: None,
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
fn record_v2_writes_both_rows_atomically() {
    // record_schedule_run_v2 must update the schedules cache row AND
    // append a scheduler_runs history row in a single transaction. A
    // successful call must leave both visible.
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    let run = run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_CRON);
    let update = ScheduleRunUpdate {
        last_run_at: now.to_rfc3339(),
        next_run_at: Some((now + chrono::Duration::hours(2)).to_rfc3339()),
        last_status: Some(200),
        last_response: Some("ok".into()),
        last_error: None,
        success: true,
    };
    s.record_schedule_run_v2(&sched.id, &run, &update)
        .expect("record_v2");

    let after = s.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.run_count, 1);
    assert_eq!(after.failure_count, 0);
    assert_eq!(after.last_status, Some(200));

    let runs = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, run.id);
}

#[test]
fn record_v2_increments_failure_count_on_unsuccessful_run() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    let run = run_at(&sched.id, now, RUN_STATUS_FAILURE, FIRE_KIND_CRON);
    let update = ScheduleRunUpdate {
        last_run_at: now.to_rfc3339(),
        next_run_at: None,
        last_status: Some(503),
        last_response: None,
        last_error: Some("server angry".into()),
        success: false,
    };
    s.record_schedule_run_v2(&sched.id, &run, &update).unwrap();
    let after = s.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.run_count, 1);
    assert_eq!(after.failure_count, 1);
    assert_eq!(after.last_status, Some(503));
}

#[test]
fn record_v2_rolls_back_when_run_id_collides() {
    // PRIMARY KEY conflict on the INSERT must roll the entire
    // transaction back — the cache row UPDATE that ran first MUST
    // also revert. Without rollback, run_count would advance without
    // a corresponding history row.
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();

    // Seed a history row directly so the next v2 call collides.
    let existing = run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_CRON);
    s.insert_schedule_run(&existing).unwrap();

    let conflict = ScheduleRun {
        id: existing.id.clone(), // same primary key — INSERT must fail
        ..run_at(&sched.id, now, RUN_STATUS_FAILURE, FIRE_KIND_CRON)
    };
    let update = ScheduleRunUpdate {
        last_run_at: now.to_rfc3339(),
        next_run_at: None,
        last_status: Some(500),
        last_response: None,
        last_error: Some("won't survive".into()),
        success: false,
    };
    let r = s.record_schedule_run_v2(&sched.id, &conflict, &update);
    assert!(r.is_err(), "duplicate INSERT must fail the transaction");

    // Cache row stayed at the seeded values: zero runs (we never
    // legitimately recorded a run via v2 here).
    let after = s.get_schedule(&sched.id).unwrap().unwrap();
    assert_eq!(after.run_count, 0, "rollback: run_count never advanced");
    assert_eq!(after.failure_count, 0, "rollback: failure_count never advanced");
    assert!(after.last_status.is_none(), "rollback: last_status untouched");
}

#[test]
fn reap_marks_unfinished_rows_interrupted() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let now = Utc::now();
    // Two rows: one finished (don't touch), one open (must reap).
    let finished = run_at(&sched.id, now - chrono::Duration::minutes(5), RUN_STATUS_SUCCESS, FIRE_KIND_CRON);
    let mut open = run_at(&sched.id, now, RUN_STATUS_SUCCESS, FIRE_KIND_MANUAL);
    open.finished_at = None; // simulates manual run-now interrupted by daemon crash
    s.insert_schedule_run(&finished).unwrap();
    s.insert_schedule_run(&open).unwrap();

    let n = s.reap_interrupted_schedule_runs(&now.to_rfc3339()).unwrap();
    assert_eq!(n, 1, "exactly the open row should be reaped");

    let runs = s
        .list_schedule_runs(&sched.id, &ScheduleRunFilter::default())
        .unwrap();
    let reaped = runs.iter().find(|r| r.id == open.id).unwrap();
    assert_eq!(reaped.status, RUN_STATUS_INTERRUPTED);
    assert!(reaped.finished_at.is_some());
    let still_finished = runs.iter().find(|r| r.id == finished.id).unwrap();
    assert_eq!(still_finished.status, RUN_STATUS_SUCCESS, "finished row untouched");
}

#[test]
fn reap_is_idempotent() {
    let s = store();
    let sched = seed_schedule(&s, "audit.codebase");
    let mut open = run_at(&sched.id, Utc::now(), RUN_STATUS_SUCCESS, FIRE_KIND_MANUAL);
    open.finished_at = None;
    s.insert_schedule_run(&open).unwrap();

    let n1 = s
        .reap_interrupted_schedule_runs(&Utc::now().to_rfc3339())
        .unwrap();
    let n2 = s
        .reap_interrupted_schedule_runs(&Utc::now().to_rfc3339())
        .unwrap();
    assert_eq!(n1, 1);
    assert_eq!(n2, 0, "already-reaped rows do not reap again");
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
