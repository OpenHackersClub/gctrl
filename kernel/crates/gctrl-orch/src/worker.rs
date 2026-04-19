use std::sync::Arc;

use anyhow::Result;
use gctrl_core::{BoardComment, Task};
use gctrl_storage::SqliteStore;

use crate::agent::{self, SpawnError};
use crate::config::OrchConfig;
use crate::prompt;

#[derive(Debug, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// Won the CAS, ran the agent, released the claim.
    Released { task_id: String },
    /// Won the CAS, agent failed or timed out — requeued for retry.
    Retried { task_id: String },
    /// Lost the CAS to another worker; no work done.
    LostRace { task_id: String },
    /// dry_run mode — logged what would have happened.
    DryRun { task_id: String },
}

pub struct Worker {
    store: Arc<SqliteStore>,
    config: OrchConfig,
}

impl Worker {
    pub fn new(store: Arc<SqliteStore>, config: OrchConfig) -> Self {
        Self { store, config }
    }

    /// One drain pass: pick up to `max_concurrent` dispatchable tasks and
    /// run them sequentially. Sequential is fine for MVP — agents are I/O
    /// bound waiting on LLM calls, not CPU bound, and one-at-a-time keeps
    /// the repo's working tree predictable.
    pub async fn run_once(&self) -> Result<Vec<DispatchOutcome>> {
        let tasks = self
            .store
            .list_dispatchable_tasks(self.config.max_concurrent)?;
        if tasks.is_empty() {
            tracing::debug!("orch: no dispatchable tasks");
            return Ok(vec![]);
        }
        let mut outcomes = Vec::with_capacity(tasks.len());
        for task in tasks {
            outcomes.push(self.dispatch_one(&task).await?);
        }
        Ok(outcomes)
    }

    /// Run forever, draining on each tick. Cancellation is via dropping
    /// the caller's tokio runtime (SIGTERM at the CLI level).
    pub async fn run_forever(&self) -> Result<()> {
        loop {
            if let Err(e) = self.run_once().await {
                tracing::error!("orch: drain pass failed: {e:#}");
            }
            tokio::time::sleep(self.config.poll_interval).await;
        }
    }

    async fn dispatch_one(&self, task: &Task) -> Result<DispatchOutcome> {
        // Unclaimed → Claimed. If the CAS loses, another worker got here
        // first; silently move on. This is the only place double-dispatch
        // is prevented.
        let won = self.store.try_transition_claim(
            &task.id,
            Task::CLAIM_UNCLAIMED,
            Task::CLAIM_CLAIMED,
        )?;
        if !won {
            tracing::info!(task_id = %task.id, "orch: lost claim race, skipping");
            return Ok(DispatchOutcome::LostRace {
                task_id: task.id.clone(),
            });
        }

        let issue_id = task
            .issue_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("task {} has no issue_id", task.id))?;
        let issue = self
            .store
            .get_board_issue(issue_id)?
            .ok_or_else(|| anyhow::anyhow!("issue {issue_id} disappeared"))?;
        let comments = self.store.list_board_comments(issue_id)?;
        let prompt = prompt::build_prompt(&issue, &comments);

        if self.config.dry_run {
            tracing::info!(
                task_id = %task.id,
                issue_id = %issue_id,
                prompt_chars = prompt.len(),
                "orch: dry-run, releasing claim"
            );
            // Release the claim so subsequent non-dry runs can pick it up.
            self.store.try_transition_claim(
                &task.id,
                Task::CLAIM_CLAIMED,
                Task::CLAIM_RELEASED,
            )?;
            return Ok(DispatchOutcome::DryRun {
                task_id: task.id.clone(),
            });
        }

        // Claimed → Running (agentLaunched). Spawn the agent; if spawn
        // itself fails we'll go Claimed → Released via the error arm below.
        self.store.try_transition_claim(
            &task.id,
            Task::CLAIM_CLAIMED,
            Task::CLAIM_RUNNING,
        )?;

        let run = agent::run_agent(
            &self.config.agent_cmd,
            &self.config.working_dir,
            &prompt,
            self.config.task_timeout,
        )
        .await;

        match run {
            Ok(result) => {
                self.post_completion_comment(issue_id, &result.stdout, true)?;
                self.store.try_transition_claim(
                    &task.id,
                    Task::CLAIM_RUNNING,
                    Task::CLAIM_RELEASED,
                )?;
                tracing::info!(task_id = %task.id, "orch: released on clean exit");
                Ok(DispatchOutcome::Released {
                    task_id: task.id.clone(),
                })
            }
            Err(e) => {
                let body = format!("## Agent run failed\n\n{e}");
                self.post_completion_comment(issue_id, &body, false)?;
                let from = match &e {
                    SpawnError::Spawn(_) => Task::CLAIM_CLAIMED,
                    _ => Task::CLAIM_RUNNING,
                };
                self.store.try_transition_claim(
                    &task.id,
                    from,
                    Task::CLAIM_RETRY_QUEUED,
                )?;
                tracing::warn!(task_id = %task.id, err = %e, "orch: retry-queued");
                Ok(DispatchOutcome::Retried {
                    task_id: task.id.clone(),
                })
            }
        }
    }

    fn post_completion_comment(&self, issue_id: &str, body: &str, ok: bool) -> Result<()> {
        let heading = if ok {
            "## Agent run completed"
        } else {
            "## Agent run failed"
        };
        let full = if body.trim_start().starts_with("## ") {
            body.to_string()
        } else {
            format!("{heading}\n\n{body}")
        };
        let comment = BoardComment {
            id: format!("cmt-{}", uuid::Uuid::new_v4()),
            issue_id: issue_id.to_string(),
            author_id: "orch".into(),
            author_name: "gctrld-orch".into(),
            author_type: "agent".into(),
            body: full,
            created_at: chrono::Utc::now(),
            session_id: None,
        };
        self.store.insert_board_comment(&comment)?;
        Ok(())
    }
}
