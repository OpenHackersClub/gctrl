//! Durable kernel execution intent and input authority; all SQL is daemon-owned.
use crate::DuckDbStore;
use chrono::Utc;
use duckdb::{params, Connection};
use gctrl_core::compute::*;

fn ledger(error: impl std::fmt::Display) -> ComputeError {
    ComputeError::Uncertain {
        detail: format!("kernel compute ledger: {error}"),
    }
}
fn phase_name(phase: ComputePhase) -> Result<String, ComputeError> {
    match serde_json::to_value(phase).map_err(ledger)? {
        serde_json::Value::String(value) => Ok(value),
        _ => Err(ledger("compute phase schema is not a string")),
    }
}
fn read_attempt(conn: &Connection, id: &str) -> Result<Option<ComputeAttempt>, ComputeError> {
    let mut stmt=conn.prepare("SELECT invocation_json,phase,cancellation_requested,snapshot_json,detail FROM gctrl_compute_attempts WHERE attempt_id=?").map_err(ledger)?;
    let mut rows = stmt.query(params![id]).map_err(ledger)?;
    let Some(row) = rows.next().map_err(ledger)? else {
        return Ok(None);
    };
    let invocation: String = row.get(0).map_err(ledger)?;
    let phase: String = row.get(1).map_err(ledger)?;
    let cancellation_requested: bool = row.get(2).map_err(ledger)?;
    let snapshot: Option<String> = row.get(3).map_err(ledger)?;
    Ok(Some(ComputeAttempt {
        invocation: serde_json::from_str(&invocation).map_err(ledger)?,
        phase: serde_json::from_value(serde_json::Value::String(phase)).map_err(ledger)?,
        cancellation_requested,
        snapshot: snapshot
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(ledger)?,
        detail: row.get(4).map_err(ledger)?,
    }))
}
fn require_attempt(conn: &Connection, id: &str) -> Result<ComputeAttempt, ComputeError> {
    read_attempt(conn, id)?.ok_or_else(|| ComputeError::NotFound {
        detail: format!("attempt {id}"),
    })
}
fn save_attempt(conn: &Connection, attempt: &ComputeAttempt) -> Result<(), ComputeError> {
    conn.execute("UPDATE gctrl_compute_attempts SET phase=?,cancellation_requested=?,snapshot_json=?,detail=?,updated_at=? WHERE attempt_id=?",params![phase_name(attempt.phase)?,attempt.cancellation_requested,attempt.snapshot.as_ref().map(serde_json::to_string).transpose().map_err(ledger)?,attempt.detail,Utc::now().to_rfc3339(),attempt.invocation.attempt_id]).map_err(ledger)?;
    Ok(())
}
impl ComputeJournal for DuckDbStore {
    fn settle(&self, id: &str) -> Result<(), ComputeError> {
        let conn = self.conn.lock().map_err(ledger)?;
        let tx = conn.unchecked_transaction().map_err(ledger)?;
        let attempt = require_attempt(&tx, id)?;
        if !matches!(
            attempt.phase,
            ComputePhase::Exited | ComputePhase::Cancelled
        ) {
            return Err(ComputeError::Conflict {
                detail: "cannot acknowledge an unconfirmed stop".into(),
            });
        }
        // A delayed acknowledgment cannot release a newer attempt.
        tx.execute(
            "DELETE FROM gctrl_compute_owners WHERE task_id=? AND attempt_id=?",
            params![attempt.invocation.task_id, id],
        )
        .map_err(ledger)?;
        tx.commit().map_err(ledger)?;
        Ok(())
    }
    fn prepare(&self, invocation: &ComputeInvocation) -> Result<ComputeAttempt, ComputeError> {
        if !uuid::Uuid::parse_str(&invocation.attempt_id)
            .is_ok_and(|id| id.to_string() == invocation.attempt_id)
        {
            return Err(ComputeError::Invalid {
                detail: "attempt identity must be a canonical UUID".into(),
            });
        }
        if [
            &invocation.task_id,
            &invocation.agent_session_id,
            &invocation.workspace_id,
            &invocation.environment_id,
        ]
        .iter()
        .any(|value| value.trim().is_empty() || value.chars().any(char::is_control))
        {
            return Err(ComputeError::Invalid {
                detail: "execution identities must be nonempty opaque values".into(),
            });
        }
        let conn = self.conn.lock().map_err(ledger)?;
        let tx = conn.unchecked_transaction().map_err(ledger)?;
        if let Some(existing) = read_attempt(&tx, &invocation.attempt_id)? {
            if &existing.invocation != invocation {
                return Err(ComputeError::Conflict {
                    detail: "attempt already belongs to another invocation".into(),
                });
            }
            tx.commit().map_err(ledger)?;
            return Ok(existing);
        }
        let authorized:i64=tx.query_row("SELECT COUNT(*) FROM sessions WHERE id=? AND workspace_id=? AND status='active' AND created_by='scheduler'",params![invocation.agent_session_id,invocation.workspace_id],|row|row.get(0)).map_err(ledger)?;
        if authorized != 1 {
            return Err(ComputeError::PermissionDenied {
                detail: "active kernel-created agent Session/workspace required".into(),
            });
        }
        let owners: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM gctrl_compute_owners WHERE task_id=?",
                params![invocation.task_id],
                |row| row.get(0),
            )
            .map_err(ledger)?;
        if owners != 0 {
            return Err(ComputeError::Conflict{detail:"Task already has an unsettled execution attempt; reconcile/fence it before replacement".into()});
        }
        let now = Utc::now().to_rfc3339();
        tx.execute("INSERT INTO gctrl_compute_attempts (attempt_id,task_id,agent_session_id,workspace_id,environment_id,phase,cancellation_requested,invocation_json,created_at,updated_at) VALUES (?,?,?,?,?,'prepared',FALSE,?,?,?)",params![invocation.attempt_id,invocation.task_id,invocation.agent_session_id,invocation.workspace_id,invocation.environment_id,serde_json::to_string(invocation).map_err(ledger)?,now,now]).map_err(ledger)?;
        tx.execute(
            "INSERT INTO gctrl_compute_owners (task_id,attempt_id) VALUES (?,?)",
            params![invocation.task_id, invocation.attempt_id],
        )
        .map_err(ledger)?;
        let attempt = require_attempt(&tx, &invocation.attempt_id)?;
        tx.commit().map_err(ledger)?;
        Ok(attempt)
    }
    fn get(&self, id: &str) -> Result<Option<ComputeAttempt>, ComputeError> {
        let conn = self.conn.lock().map_err(ledger)?;
        read_attempt(&conn, id)
    }
    fn unsettled(&self) -> Result<Vec<ComputeAttempt>, ComputeError> {
        let conn = self.conn.lock().map_err(ledger)?;
        let mut statement = conn
            .prepare("SELECT attempt_id FROM gctrl_compute_owners ORDER BY task_id")
            .map_err(ledger)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(ledger)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ledger)?;
        ids.into_iter()
            .map(|id| require_attempt(&conn, &id))
            .collect()
    }
    fn record(&self, snapshot: &ComputeSnapshot) -> Result<ComputeAttempt, ComputeError> {
        let conn = self.conn.lock().map_err(ledger)?;
        let tx = conn.unchecked_transaction().map_err(ledger)?;
        let mut attempt = require_attempt(&tx, &snapshot.attempt_id)?;
        let expected = attempt.invocation.fingerprint()?;
        if snapshot.host_id.is_empty()
            || (snapshot.phase == ComputePhase::Running
                && snapshot
                    .process_incarnation
                    .as_deref()
                    .is_none_or(str::is_empty))
            || (snapshot.phase == ComputePhase::Exited && snapshot.exit_code.is_none())
            || (snapshot.invocation_hash.as_deref() != Some(expected.as_str())
                && !(snapshot.phase == ComputePhase::Cancelled
                    && snapshot.invocation_hash.is_none()))
        {
            return Err(ComputeError::Uncertain{detail:"target receipt did not establish the bound invocation/host/process/exit identity".into()});
        }
        if let Some(previous) = &attempt.snapshot {
            if previous.host_id != snapshot.host_id
                || (previous.process_incarnation.is_some()
                    && snapshot.process_incarnation.is_some()
                    && previous.process_incarnation != snapshot.process_incarnation)
            {
                return Err(ComputeError::Uncertain {
                    detail: "target host/process incarnation changed during reconciliation".into(),
                });
            }
        }
        if matches!(
            attempt.phase,
            ComputePhase::Exited | ComputePhase::Cancelled
        ) && attempt.phase != snapshot.phase
        {
            return Err(ComputeError::Conflict {
                detail: "a late receipt cannot reopen or replace a confirmed terminal attempt"
                    .into(),
            });
        }
        attempt.phase = if attempt.cancellation_requested
            && !matches!(
                snapshot.phase,
                ComputePhase::Exited | ComputePhase::Cancelled
            ) {
            ComputePhase::CancelRequested
        } else {
            snapshot.phase
        };
        attempt.detail = snapshot.detail.clone();
        attempt.snapshot = Some(snapshot.clone());
        save_attempt(&tx, &attempt)?;
        tx.commit().map_err(ledger)?;
        Ok(attempt)
    }
    fn mark(
        &self,
        id: &str,
        phase: ComputePhase,
        detail: &str,
    ) -> Result<ComputeAttempt, ComputeError> {
        if !matches!(
            phase,
            ComputePhase::Uncertain | ComputePhase::CancelRequested
        ) {
            return Err(ComputeError::Invalid {
                detail: "local intent cannot assert target-confirmed execution or stop".into(),
            });
        }
        let conn = self.conn.lock().map_err(ledger)?;
        let tx = conn.unchecked_transaction().map_err(ledger)?;
        let mut attempt = require_attempt(&tx, id)?;
        if !matches!(
            attempt.phase,
            ComputePhase::Exited | ComputePhase::Cancelled
        ) {
            attempt.phase = phase;
            attempt.cancellation_requested |= phase == ComputePhase::CancelRequested;
            attempt.detail = Some(detail.into());
            save_attempt(&tx, &attempt)?;
        }
        tx.commit().map_err(ledger)?;
        Ok(attempt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctrl_core::{CreatedBy, DeviceId, Session, SessionId, SessionStatus, WorkspaceId};
    fn session(id: &str, created_by: CreatedBy) -> Session {
        Session {
            id: SessionId(id.into()),
            workspace_id: WorkspaceId("workspace".into()),
            device_id: DeviceId("host".into()),
            agent_name: "agent".into(),
            started_at: Utc::now(),
            ended_at: None,
            status: SessionStatus::Active,
            total_cost_usd: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            created_by,
            project_id: None,
            kind: "agent.execution".into(),
            metadata: None,
        }
    }
    fn invocation() -> ComputeInvocation {
        ComputeInvocation {
            attempt_id: uuid::Uuid::new_v4().to_string(),
            task_id: "task".into(),
            agent_session_id: "session".into(),
            workspace_id: "workspace".into(),
            environment_id: "environment".into(),
            program: "/bin/true".into(),
            args: vec![],
            cwd: "/target/workspace".into(),
            stdin: String::new(),
            env: Default::default(),
            timeout_seconds: 30,
        }
    }
    fn snapshot(invocation: &ComputeInvocation, phase: ComputePhase) -> ComputeSnapshot {
        ComputeSnapshot {
            attempt_id: invocation.attempt_id.clone(),
            invocation_hash: Some(invocation.fingerprint().unwrap()),
            host_id: "machine:boot".into(),
            process_incarnation: Some("machine:boot:pid:start".into()),
            phase,
            exit_code: if phase == ComputePhase::Exited {
                Some(0)
            } else {
                None
            },
            stdout: "partial output".into(),
            stderr: String::new(),
            detail: None,
        }
    }
    #[test]
    fn compute_ledger_reserves_one_attempt_and_preserves_uncertainty_across_controller_recreation()
    {
        let store = DuckDbStore::open(":memory:").unwrap();
        store
            .insert_session(&session("session", CreatedBy::Scheduler))
            .unwrap();
        let invocation = invocation();
        let id = &invocation.attempt_id;
        assert_eq!(
            store.prepare(&invocation).unwrap().phase,
            ComputePhase::Prepared
        );
        assert_eq!(store.prepare(&invocation).unwrap().invocation, invocation);
        let running = snapshot(&invocation, ComputePhase::Running);
        store.record(&running).unwrap();
        store
            .mark(id, ComputePhase::Uncertain, "SSH disconnected")
            .unwrap();
        let recreated: &dyn ComputeJournal = &store;
        assert_eq!(
            recreated.get(id).unwrap().unwrap().phase,
            ComputePhase::Uncertain
        );
        assert_eq!(recreated.unsettled().unwrap().len(), 1);
        let mut replacement = invocation.clone();
        replacement.attempt_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            store.prepare(&replacement),
            Err(ComputeError::Conflict { .. })
        ));
        assert_eq!(store.record(&running).unwrap().phase, ComputePhase::Running);
        let cancelled = snapshot(&invocation, ComputePhase::Cancelled);
        store.record(&cancelled).unwrap();
        assert_eq!(
            store.unsettled().unwrap().len(),
            1,
            "terminal receipts must survive the crash before the claim is updated"
        );
        store.settle(id).unwrap();
        assert!(store.unsettled().unwrap().is_empty());
        assert!(store.prepare(&replacement).is_ok());
        store.record(&cancelled).unwrap();
        store.settle(id).unwrap();
        assert_eq!(
            store.unsettled().unwrap()[0].invocation,
            replacement,
            "late completion must not release a newer reservation"
        );
    }
    #[test]
    fn compute_ledger_rejects_forged_session_workspace_and_reused_invocation() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let mut invocation = invocation();
        assert!(matches!(
            store.prepare(&invocation),
            Err(ComputeError::PermissionDenied { .. })
        ));
        store
            .insert_session(&session("session", CreatedBy::Api))
            .unwrap();
        assert!(matches!(
            store.prepare(&invocation),
            Err(ComputeError::PermissionDenied { .. })
        ));
        store
            .insert_session(&session("session", CreatedBy::Scheduler))
            .unwrap();
        invocation.workspace_id = "other-workspace".into();
        assert!(matches!(
            store.prepare(&invocation),
            Err(ComputeError::PermissionDenied { .. })
        ));
        invocation.workspace_id = "workspace".into();
        store.prepare(&invocation).unwrap();
        assert!(
            store.settle(&invocation.attempt_id).is_err(),
            "unfinished attempts cannot be acknowledged"
        );
        invocation.program = "/bin/other".into();
        assert!(matches!(
            store.prepare(&invocation),
            Err(ComputeError::Conflict { .. })
        ));
    }
    #[test]
    fn compute_ledger_does_not_turn_requested_cancellation_or_absent_exit_evidence_into_a_confirmed_stop(
    ) {
        let store = DuckDbStore::open(":memory:").unwrap();
        store
            .insert_session(&session("session", CreatedBy::Scheduler))
            .unwrap();
        let invocation = invocation();
        let id = &invocation.attempt_id;
        store.prepare(&invocation).unwrap();
        store
            .mark(id, ComputePhase::CancelRequested, "cancel sent")
            .unwrap();
        assert_eq!(
            store.unsettled().unwrap()[0].phase,
            ComputePhase::CancelRequested
        );
        let mut missing = snapshot(&invocation, ComputePhase::Exited);
        missing.exit_code = None;
        assert!(store.record(&missing).is_err());
        assert!(store
            .mark(id, ComputePhase::Cancelled, "caller asserted stop")
            .is_err());
        assert_eq!(
            store.get(id).unwrap().unwrap().phase,
            ComputePhase::CancelRequested
        );
        store
            .mark(id, ComputePhase::Uncertain, "cancel RPC lost")
            .unwrap();
        assert!(store.get(id).unwrap().unwrap().cancellation_requested);
        let running = snapshot(&invocation, ComputePhase::Running);
        assert_eq!(
            store.record(&running).unwrap().phase,
            ComputePhase::CancelRequested,
            "a late running receipt must not erase requested cancellation"
        );
        let mut wrong_hash = snapshot(&invocation, ComputePhase::Cancelled);
        wrong_hash.invocation_hash = Some("unrelated".into());
        assert!(store.record(&wrong_hash).is_err());
        assert_eq!(store.unsettled().unwrap().len(), 1);
        let mut missing = snapshot(&invocation, ComputePhase::Running);
        missing.attempt_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            store.record(&missing),
            Err(ComputeError::NotFound { .. })
        ));
    }
}
