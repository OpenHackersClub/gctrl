use std::sync::Arc;

use anyhow::Result;
use gctrl_core::{BoardComment, Task};
use gctrl_storage::SqliteStore;

use crate::agent;
use crate::config::OrchConfig;
use crate::prompt;

/// Cap on the agent stdout we echo into a completion comment. A real
/// `claude -p` session can produce tens of thousands of lines; we keep
/// the tail and flag truncation so the board stays readable.
const COMPLETION_COMMENT_MAX_BYTES: usize = 50_000;

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

    /// One drain pass: pick up to `max_per_pass` dispatchable tasks and
    /// run them sequentially. Sequential is fine for MVP — agents are I/O
    /// bound waiting on LLM calls, not CPU bound, and one-at-a-time keeps
    /// the repo's working tree predictable.
    pub async fn run_once(&self) -> Result<Vec<DispatchOutcome>> {
        let tasks = self
            .store
            .list_dispatchable_tasks(self.config.max_per_pass)?;
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
                "orch: dry-run, returning task to Unclaimed"
            );
            // Non-destructive: put it back in the queue so a real run picks
            // it up. The CAS target is Unclaimed — same pool list_dispatchable
            // filters on.
            self.strict_transition(&task.id, Task::CLAIM_CLAIMED, Task::CLAIM_UNCLAIMED)?;
            return Ok(DispatchOutcome::DryRun {
                task_id: task.id.clone(),
            });
        }

        // Spawn first, *then* transition Claimed → Running. This matches the
        // Lean spec: `dispatchFailed` (Claimed → Released) vs `agentLaunched`
        // (Claimed → Running) vs `agentExitAbnormal` (Running → RetryQueued).
        let child = match agent::spawn_agent(
            &self.config.agent_cmd,
            &self.config.working_dir,
            &prompt,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                let body = format!("## Agent run failed (spawn)\n\n{e}");
                self.post_completion_comment(issue_id, &body, false)?;
                self.strict_transition(
                    &task.id,
                    Task::CLAIM_CLAIMED,
                    Task::CLAIM_RELEASED,
                )?;
                tracing::warn!(task_id = %task.id, err = %e, "orch: dispatchFailed");
                return Ok(DispatchOutcome::Retried {
                    task_id: task.id.clone(),
                });
            }
        };

        // agentLaunched.
        self.strict_transition(&task.id, Task::CLAIM_CLAIMED, Task::CLAIM_RUNNING)?;

        match agent::await_agent(child, self.config.task_timeout).await {
            Ok(result) => {
                self.post_completion_comment(issue_id, &result.stdout, true)?;
                self.strict_transition(
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
                self.strict_transition(
                    &task.id,
                    Task::CLAIM_RUNNING,
                    Task::CLAIM_RETRY_QUEUED,
                )?;
                tracing::warn!(task_id = %task.id, err = %e, "orch: retry-queued");
                Ok(DispatchOutcome::Retried {
                    task_id: task.id.clone(),
                })
            }
        }
    }

    /// Non-contended transitions after the initial CAS win. We still route
    /// through `try_transition_claim` so the single chokepoint property holds,
    /// but we *expect* this to succeed — if it doesn't, something outside the
    /// worker is mutating the row and the state machine is compromised.
    fn strict_transition(&self, task_id: &str, from: &str, to: &str) -> Result<()> {
        let ok = self.store.try_transition_claim(task_id, from, to)?;
        if !ok {
            anyhow::bail!(
                "orch: expected transition {from}→{to} on {task_id} but CAS failed — \
                 row was mutated externally"
            );
        }
        Ok(())
    }

    fn post_completion_comment(&self, issue_id: &str, body: &str, ok: bool) -> Result<()> {
        let heading = if ok {
            "## Agent run completed"
        } else {
            "## Agent run failed"
        };
        let body = truncate_tail(body, COMPLETION_COMMENT_MAX_BYTES);
        let full = if body.trim_start().starts_with("## ") {
            body.into_owned()
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

/// Keep the last `max_bytes` of `body`, prepending a truncation marker if
/// anything was dropped. Agent stdout tends to end with the useful summary,
/// so tail-truncation preserves what reviewers care about.
fn truncate_tail(body: &str, max_bytes: usize) -> std::borrow::Cow<'_, str> {
    if body.len() <= max_bytes {
        return std::borrow::Cow::Borrowed(body);
    }
    let dropped = body.len() - max_bytes;
    // Find a char boundary at-or-after the cut point so we don't slice mid-UTF-8.
    let mut cut = body.len() - max_bytes;
    while cut < body.len() && !body.is_char_boundary(cut) {
        cut += 1;
    }
    std::borrow::Cow::Owned(format!(
        "_[truncated {dropped} bytes from the head]_\n\n{}",
        &body[cut..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_tail_is_noop_when_under_limit() {
        let out = truncate_tail("short", 100);
        assert_eq!(out, "short");
    }

    #[test]
    fn truncate_tail_keeps_end_with_marker() {
        let body: String = "x".repeat(1000) + "TAIL";
        let out = truncate_tail(&body, 100);
        assert!(out.starts_with("_[truncated"));
        assert!(out.ends_with("TAIL"));
    }
}
