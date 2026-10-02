//! Durable execution identity and the compute port; no native process handles.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeInvocation {
    pub attempt_id: String,
    pub task_id: String,
    pub agent_session_id: String,
    pub workspace_id: String,
    pub environment_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub stdin: String,
    /// Explicit child environment. The SSH supervisor's environment is not inherited.
    pub env: BTreeMap<String, String>,
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputePhase {
    Prepared,
    Running,
    Exited,
    CancelRequested,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeSnapshot {
    pub attempt_id: String,
    pub invocation_hash: Option<String>,
    pub host_id: String,
    pub process_incarnation: Option<String>,
    pub phase: ComputePhase,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub detail: Option<String>,
}

/// Operator-owned OpenSSH alias and target-host tooling. No credentials are
/// copied into the invocation; normal OpenSSH configuration resolves them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshComputeConfig {
    pub environment_id: String,
    pub ssh_alias: String,
    pub ssh_config: Option<PathBuf>,
    pub python_path: String,
    pub helper_path: String,
    pub state_root: String,
    /// Existing delegated cgroup-v2 subtree on the target host.
    pub cgroup_root: String,
}

/// Operator-selected execution environment. Paths and variables are target
/// host values; the controller never imports its own HOME/PATH or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeWorkerConfig {
    pub workspace_id: String,
    pub environment_id: String,
    pub agent_command: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout_seconds: u32,
    pub max_per_pass: usize,
    pub kernel_base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputeError {
    #[error("invalid compute request: {detail}")]
    Invalid { detail: String },
    #[error("compute attempt conflict: {detail}")]
    Conflict { detail: String },
    #[error("compute attempt not found: {detail}")]
    NotFound { detail: String },
    #[error("compute capability unavailable: {detail}")]
    Unsupported { detail: String },
    #[error("compute permission denied: {detail}")]
    PermissionDenied { detail: String },
    #[error("compute outcome uncertain; reconcile/fence before replacement: {detail}")]
    Uncertain { detail: String },
}

#[async_trait]
pub trait ComputeSubstrate: Send + Sync {
    fn environment_id(&self) -> &str;
    /// Persist kernel intent before calling this. Resubmission of the same
    /// attempt is idempotent; an uncertain acknowledgment cannot create a new attempt.
    async fn launch(&self, invocation: &ComputeInvocation)
        -> Result<ComputeSnapshot, ComputeError>;
    async fn reconcile(&self, attempt_id: &str) -> Result<ComputeSnapshot, ComputeError>;
    /// A requested stop is not a confirmed stop. Never report cancellation on
    /// transport loss or while the target's prior process group can still run.
    async fn cancel(&self, attempt_id: &str) -> Result<ComputeSnapshot, ComputeError>;
}

/// Selected target-host tooling transport, shared by compute and native GUI
/// drivers. The caller supplies a configured absolute helper path, not shell text.
#[async_trait]
pub trait TargetHostPort: Send + Sync {
    fn environment_id(&self) -> &str;
    async fn request(
        &self,
        helper_path: &str,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, ComputeError>;
}

/// Kernel-owned launch intent. Target state is evidence; this record owns the
/// Task/session/workspace relationship and the prohibition on replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeAttempt {
    pub invocation: ComputeInvocation,
    pub phase: ComputePhase,
    pub cancellation_requested: bool,
    pub snapshot: Option<ComputeSnapshot>,
    pub detail: Option<String>,
}

/// A single-writer kernel ledger. Prepare must reject another unsettled
/// attempt for the same Task and must validate a kernel-created agent Session.
pub trait ComputeJournal: Send + Sync {
    fn prepare(&self, invocation: &ComputeInvocation) -> Result<ComputeAttempt, ComputeError>;
    fn get(&self, attempt_id: &str) -> Result<Option<ComputeAttempt>, ComputeError>;
    fn unsettled(&self) -> Result<Vec<ComputeAttempt>, ComputeError>;
    fn record(&self, snapshot: &ComputeSnapshot) -> Result<ComputeAttempt, ComputeError>;
    /// Release a confirmed terminal reservation only after the orchestrator
    /// has durably recorded its corresponding claim transition.
    fn settle(&self, attempt_id: &str) -> Result<(), ComputeError>;
    fn mark(
        &self,
        attempt_id: &str,
        phase: ComputePhase,
        detail: &str,
    ) -> Result<ComputeAttempt, ComputeError>;
}

impl ComputeInvocation {
    /// Cross-language canonical SHA-256 used to reject a misbound target receipt.
    pub fn fingerprint(&self) -> Result<String, ComputeError> {
        use sha2::{Digest, Sha256};
        let mut value = serde_json::to_value(self).map_err(|e| ComputeError::Invalid {
            detail: format!("invocation schema: {e}"),
        })?;
        value.sort_all_objects();
        let bytes = serde_json::to_vec(&value).map_err(|e| ComputeError::Invalid {
            detail: format!("invocation JSON: {e}"),
        })?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invocation_fingerprint_is_canonical_and_preserves_unicode_and_argv() {
        let invocation = ComputeInvocation {
            attempt_id: "id".into(),
            task_id: "task".into(),
            agent_session_id: "session".into(),
            workspace_id: "workspace".into(),
            environment_id: "environment".into(),
            program: "/bin/echo".into(),
            args: vec!["héllo 🌍".into(), "$(literal)".into()],
            cwd: "/target".into(),
            stdin: "line\n".into(),
            env: BTreeMap::from([("Z".into(), "last".into()), ("A".into(), "first".into())]),
            timeout_seconds: 30,
        };
        assert_eq!(
            invocation.fingerprint().unwrap(),
            "112c080fa83b0b17f859fa3a7ca3109fe44477d921641fdbfad300d8cb55f314"
        );
        let mut changed = invocation;
        changed.task_id = "other".into();
        assert_ne!(
            changed.fingerprint().unwrap(),
            "112c080fa83b0b17f859fa3a7ca3109fe44477d921641fdbfad300d8cb55f314"
        );
    }
}
