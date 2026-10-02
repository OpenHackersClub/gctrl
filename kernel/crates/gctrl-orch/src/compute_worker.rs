//! Durable remote execution attached to existing orchestrator claims.
use crate::{prompt, DispatchOutcome};
use chrono::Utc;
use gctrl_core::{
    compute::*, BoardComment, CreatedBy, DeviceId, OrchTask, Session, SessionId, SessionStatus,
    WorkspaceId,
};
use gctrl_storage::{DuckDbStore, SqliteStore};
use std::sync::Arc;

pub struct ComputeWorker {
    store: Arc<SqliteStore>,
    ledger: Arc<DuckDbStore>,
    substrate: Arc<dyn ComputeSubstrate>,
    config: ComputeWorkerConfig,
    pass: tokio::sync::Mutex<()>,
}
fn uncertain(error: impl std::fmt::Display) -> ComputeError {
    ComputeError::Uncertain {
        detail: format!("compute controller: {error}"),
    }
}
fn terminal(phase: ComputePhase) -> bool {
    matches!(phase, ComputePhase::Exited | ComputePhase::Cancelled)
}
impl ComputeWorker {
    /// Opt-in attachment to an operator-selected target. This does not replace
    /// the legacy local worker or provision a VM/container/GUI environment.
    pub fn new(
        store: Arc<SqliteStore>,
        ledger: Arc<DuckDbStore>,
        substrate: Arc<dyn ComputeSubstrate>,
        config: ComputeWorkerConfig,
    ) -> Result<Self, ComputeError> {
        if [&config.workspace_id, &config.environment_id]
            .iter()
            .any(|v| v.trim().is_empty() || v.chars().any(char::is_control))
            || config.environment_id != substrate.environment_id()
            || config
                .agent_command
                .first()
                .is_none_or(|p| !p.starts_with('/') || p.contains('\0'))
            || config.agent_command.iter().any(|p| p.contains('\0'))
            || !config.cwd.starts_with('/')
            || config.cwd.contains('\0')
            || !(1..=86400).contains(&config.timeout_seconds)
            || !(1..=64).contains(&config.max_per_pass)
            || config
                .env
                .iter()
                .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
        {
            return Err(ComputeError::Invalid { detail: "explicit environment/workspace, absolute target program/cwd, bounded timeout/batch, and valid target env required".into() });
        }
        Ok(Self {
            store,
            ledger,
            substrate,
            config,
            pass: tokio::sync::Mutex::new(()),
        })
    }

    /// Reconcile all retained attempts before selecting new eligible claims.
    /// A dropped launch future leaves an uncertain ledger record, never an
    /// unreserved Task eligible for another launch.
    pub async fn run_once(&self) -> Result<Vec<DispatchOutcome>, ComputeError> {
        let _pass = self.pass.lock().await;
        let mut outcomes = Vec::new();
        for attempt in self.ledger.unsettled()? {
            if attempt.invocation.environment_id == self.config.environment_id {
                outcomes.push(self.recover(attempt).await?);
            }
        }
        let tasks = self
            .store
            .list_dispatchable_tasks(self.config.max_per_pass)
            .map_err(uncertain)?;
        for task in tasks {
            if !self
                .store
                .try_transition_claim(&task.id, OrchTask::CLAIM_UNCLAIMED, OrchTask::CLAIM_CLAIMED)
                .map_err(uncertain)?
            {
                continue;
            }
            // Claim wins before kernel-created Session/intent. Any failure here
            // keeps Claimed; no target launch has been authorized on failure.
            let invocation = self.invocation(&task)?;
            self.ledger.prepare(&invocation)?;
            self.ledger.mark(
                &invocation.attempt_id,
                ComputePhase::Uncertain,
                "launch intent committed; acknowledgment pending",
            )?;
            tracing::info!(task_id=%task.id,attempt_id=%invocation.attempt_id,environment_id=%invocation.environment_id,"compute.dispatch");
            let receipt = self.substrate.launch(&invocation).await;
            let attempt = self.accept(&invocation.attempt_id, receipt)?;
            outcomes.push(self.finish(attempt)?);
        }
        Ok(outcomes)
    }

    /// Persist requested cancellation before sending it. A lost acknowledgment
    /// retains the intent so the next drain/restart repeats fencing, not launch.
    pub async fn cancel(&self, id: &str) -> Result<ComputeAttempt, ComputeError> {
        let attempt = self.require_attempt(id)?;
        if terminal(attempt.phase) {
            return Ok(attempt);
        }
        self.require_live_task(&attempt)?;
        self.ledger.mark(
            id,
            ComputePhase::CancelRequested,
            "operator requested cancellation",
        )?;
        let receipt = self.substrate.cancel(id).await;
        self.accept(id, receipt)
    }

    fn require_attempt(&self, id: &str) -> Result<ComputeAttempt, ComputeError> {
        let attempt = self.ledger.get(id)?.ok_or_else(|| ComputeError::NotFound {
            detail: format!("attempt {id}"),
        })?;
        if attempt.invocation.environment_id != self.config.environment_id {
            return Err(ComputeError::PermissionDenied {
                detail: "attempt belongs to a different execution environment".into(),
            });
        }
        Ok(attempt)
    }
    fn task(&self, id: &str) -> Result<OrchTask, ComputeError> {
        self.store
            .get_orch_task(id)
            .map_err(uncertain)?
            .ok_or_else(|| ComputeError::NotFound {
                detail: format!("orchestrator Task {id}"),
            })
    }
    fn require_live_task(&self, attempt: &ComputeAttempt) -> Result<OrchTask, ComputeError> {
        let task = self.task(&attempt.invocation.task_id)?;
        if !matches!(
            task.orchestrator_claim.as_str(),
            OrchTask::CLAIM_CLAIMED | OrchTask::CLAIM_RUNNING
        ) {
            return Err(ComputeError::Conflict {
                detail: "unsettled execution requires its existing Claimed/Running Task".into(),
            });
        }
        Ok(task)
    }
    async fn recover(&self, attempt: ComputeAttempt) -> Result<DispatchOutcome, ComputeError> {
        if terminal(attempt.phase) {
            return self.finish(attempt);
        }
        self.require_live_task(&attempt)?;
        let id = &attempt.invocation.attempt_id;
        let receipt = if attempt.cancellation_requested {
            self.substrate.cancel(id).await
        } else {
            self.substrate.reconcile(id).await
        };
        self.finish(self.accept(id, receipt)?)
    }
    fn accept(
        &self,
        id: &str,
        receipt: Result<ComputeSnapshot, ComputeError>,
    ) -> Result<ComputeAttempt, ComputeError> {
        match receipt {
            Ok(snapshot) if snapshot.attempt_id == id => match self.ledger.record(&snapshot) {
                Ok(attempt) => Ok(attempt),
                Err(error) => self
                    .ledger
                    .mark(id, ComputePhase::Uncertain, &error.to_string()),
            },
            Ok(_) => self.ledger.mark(
                id,
                ComputePhase::Uncertain,
                "target receipt belongs to a different attempt",
            ),
            Err(error) => self
                .ledger
                .mark(id, ComputePhase::Uncertain, &error.to_string()),
        }
    }
    fn invocation(&self, task: &OrchTask) -> Result<ComputeInvocation, ComputeError> {
        let issue_id = task
            .issue_id
            .as_deref()
            .ok_or_else(|| uncertain("claimed Task has no Issue"))?;
        let issue = self
            .store
            .get_board_issue(issue_id)
            .map_err(uncertain)?
            .ok_or_else(|| uncertain("claimed Issue disappeared"))?;
        let comments = self
            .store
            .list_board_comments(issue_id)
            .map_err(uncertain)?;
        let checks = issue
            .acceptance_criteria
            .as_deref()
            .map(gctrl_core::parse_acceptance_criteria)
            .unwrap_or_default();
        let session_id = uuid::Uuid::new_v4().to_string();
        self.ledger
            .insert_session(&Session {
                id: SessionId(session_id.clone()),
                workspace_id: WorkspaceId(self.config.workspace_id.clone()),
                // Actual target host identity is attested in the compute receipt;
                // this Session is initially attributed to the selected environment.
                device_id: DeviceId(self.config.environment_id.clone()),
                agent_name: task.agent_kind.clone(),
                started_at: Utc::now(),
                ended_at: None,
                status: SessionStatus::Active,
                total_cost_usd: 0.0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                created_by: CreatedBy::Scheduler,
                project_id: Some(issue.project_id.clone()),
                kind: "agent.execution".into(),
                metadata: None,
            })
            .map_err(uncertain)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut env = self.config.env.clone();
        for (key, value) in [
            ("GCTRL_TASK_ID", task.id.as_str()),
            ("GCTRL_AGENT_SESSION_ID", session_id.as_str()),
            ("GCTRL_WORKSPACE_ID", self.config.workspace_id.as_str()),
            ("GCTRL_ENVIRONMENT_ID", self.config.environment_id.as_str()),
            ("GCTRL_COMPUTE_ATTEMPT_ID", id.as_str()),
        ] {
            env.insert(key.into(), value.into());
        }
        Ok(ComputeInvocation {
            attempt_id: id,
            task_id: task.id.clone(),
            agent_session_id: session_id,
            workspace_id: self.config.workspace_id.clone(),
            environment_id: self.config.environment_id.clone(),
            program: self.config.agent_command[0].clone(),
            args: self.config.agent_command[1..].to_vec(),
            cwd: self.config.cwd.clone(),
            stdin: prompt::build_prompt(&issue, &comments, &checks, &self.config.kernel_base_url),
            env,
            timeout_seconds: self.config.timeout_seconds,
        })
    }
    fn transition(&self, id: &str, from: &str, to: &str) -> Result<(), ComputeError> {
        if !self
            .store
            .try_transition_claim(id, from, to)
            .map_err(uncertain)?
        {
            // Another recovery caller may already have made the same transition.
            if self.task(id)?.orchestrator_claim != to {
                return Err(uncertain(format!("claim {id} changed during {from}→{to}")));
            }
        }
        Ok(())
    }
    fn finish(&self, attempt: ComputeAttempt) -> Result<DispatchOutcome, ComputeError> {
        let inv = &attempt.invocation;
        let mut task = self.task(&inv.task_id)?;
        let observed_execution = attempt
            .snapshot
            .as_ref()
            .is_some_and(|s| s.process_incarnation.is_some());
        if (attempt.phase == ComputePhase::Running || terminal(attempt.phase))
            && observed_execution
            && task.orchestrator_claim == OrchTask::CLAIM_CLAIMED
        {
            self.transition(&task.id, OrchTask::CLAIM_CLAIMED, OrchTask::CLAIM_RUNNING)?;
            task.orchestrator_claim = OrchTask::CLAIM_RUNNING.into();
        }
        if !terminal(attempt.phase) {
            self.require_live_task(&attempt)?;
            return Ok(DispatchOutcome::AwaitingReconciliation { task_id: task.id });
        }
        let snapshot = attempt
            .snapshot
            .as_ref()
            .ok_or_else(|| uncertain("terminal attempt lacks target receipt"))?;
        let clean = snapshot.phase == ComputePhase::Exited && snapshot.exit_code == Some(0);
        let final_claim =
            if task.orchestrator_claim == OrchTask::CLAIM_CLAIMED && !observed_execution {
                OrchTask::CLAIM_RELEASED // confirmed cancellation before launch
            } else if clean {
                OrchTask::CLAIM_RELEASED
            } else {
                OrchTask::CLAIM_RETRY_QUEUED
            };
        if task.orchestrator_claim != final_claim {
            if !matches!(
                task.orchestrator_claim.as_str(),
                OrchTask::CLAIM_CLAIMED | OrchTask::CLAIM_RUNNING
            ) {
                return Err(uncertain(
                    "terminal attempt conflicts with recorded Task claim",
                ));
            }
            self.transition(&task.id, &task.orchestrator_claim, final_claim)?;
        }
        // Keep ownership through claim update AND idempotent completion import.
        let issue_id = task
            .issue_id
            .as_deref()
            .ok_or_else(|| uncertain("completed Task has no Issue"))?;
        let comment_id = format!("compute-completion-{}", inv.attempt_id);
        if !self
            .store
            .list_board_comments(issue_id)
            .map_err(uncertain)?
            .iter()
            .any(|c| c.id == comment_id)
        {
            let output = format!(
                "{}\n\n{}\n{}",
                if clean {
                    "## Agent run completed"
                } else {
                    "## Agent run stopped"
                },
                snapshot.stdout,
                snapshot.stderr
            );
            self.store
                .insert_board_comment(&BoardComment {
                    id: comment_id,
                    issue_id: issue_id.into(),
                    author_id: "orch".into(),
                    author_name: "gctrld-orch".into(),
                    author_type: "agent".into(),
                    body: crate::worker::truncate_tail(&output, 50_000).into_owned(),
                    created_at: Utc::now(),
                    session_id: Some(inv.agent_session_id.clone()),
                })
                .map_err(uncertain)?;
        }
        let session_status = if snapshot.phase == ComputePhase::Cancelled {
            SessionStatus::Cancelled
        } else if clean {
            SessionStatus::Completed
        } else {
            SessionStatus::Failed
        };
        self.ledger
            .end_session(&inv.agent_session_id, session_status.as_str())
            .map_err(uncertain)?;
        self.ledger.settle(&inv.attempt_id)?;
        tracing::info!(task_id=%task.id,attempt_id=%inv.attempt_id,phase=?snapshot.phase,"compute.settled");
        Ok(if final_claim == OrchTask::CLAIM_RELEASED {
            DispatchOutcome::Released { task_id: task.id }
        } else {
            DispatchOutcome::Retried { task_id: task.id }
        })
    }
}
