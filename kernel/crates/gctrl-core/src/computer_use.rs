//! Explicit computer-use targets and kernel/driver contracts. These types carry
//! input ownership without changing orchestrator claim states.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopIdentity {
    pub host_id: String,
    pub login_session: String,
    /// Attested by the driver from the actual display/input server incarnation.
    /// A worktree path, Space, monitor, or caller-supplied label cannot supply it.
    pub runtime_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplicationIdentity {
    Window {
        application: String,
        process_incarnation: String,
        window_id: String,
        window_incarnation: String,
    },
    Browser {
        browser_session_id: String,
        browser_context_id: String,
        tab_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetIdentity {
    /// Driver-issued discovery identifier. Requests select this identifier,
    /// never the frontmost application or a positional screen/tab reference.
    pub id: String,
    pub desktop: DesktopIdentity,
    pub application: ApplicationIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRequest {
    pub task_id: String,
    pub agent_session_id: String,
    pub workspace_id: String,
    pub environment_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetBinding {
    pub id: String,
    pub request: BindingRequest,
    pub target: TargetIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    pub target: TargetIdentity,
    /// Opaque driver revision of content, navigation, focus, and input epoch.
    pub revision: String,
    pub text: String,
    pub image_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub binding_id: String,
    pub snapshot: TargetSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputAction {
    Click { x: i32, y: i32 },
    TypeText { text: String },
    Key { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExpectedEffect {
    TextContains { text: String },
    RevisionEquals { revision: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionStep {
    pub action: InputAction,
    pub expected: ExpectedEffect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Ready,
    TakeoverRequested,
    HumanControl,
    CancelRequested,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    pub binding: TargetBinding,
    pub status: ControlStatus,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReceipt {
    pub attempt_id: String,
    pub binding_id: String,
    pub verified_steps: usize,
    pub final_observation: Observation,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputerUseError {
    #[error("invalid computer-use request: {detail}")]
    Invalid { detail: String },
    #[error("computer-use target/binding not found: {id}")]
    NotFound { id: String },
    #[error("computer-use capability unavailable: {detail}")]
    Unsupported { detail: String },
    #[error("computer-use permission denied: {detail}")]
    PermissionDenied { detail: String },
    #[error("computer-use input ownership conflict: {detail}")]
    Conflict { detail: String },
    #[error("computer-use observation/identity is stale: {detail}")]
    Stale { detail: String },
    #[error("computer-use interrupted: {detail}")]
    Interrupted { detail: String },
    #[error("computer-use verification failed: {detail}")]
    Verification { detail: String },
    #[error("computer-use outcome uncertain; fence/reconcile before resuming: {detail}")]
    Uncertain { detail: String },
    #[error("computer-use journal unavailable: {detail}")]
    Journal { detail: String },
}

/// The driver MUST check this immediately before every input atom. Revocation
/// can occur while a batch is in flight; it is not conditional on holding a
/// coordinator mutex or completing a network round-trip.
pub trait InputPermit: Send + Sync {
    fn check(&self) -> Result<(), ComputerUseError>;
}

#[async_trait]
pub trait ComputerUseDriver: Send + Sync {
    fn environment_id(&self) -> &str;
    async fn discover(&self) -> Result<Vec<TargetIdentity>, ComputerUseError>;
    async fn observe(&self, target: &TargetIdentity) -> Result<TargetSnapshot, ComputerUseError>;
    async fn apply(
        &self,
        target: &TargetIdentity,
        action: &InputAction,
        permit: &dyn InputPermit,
    ) -> Result<(), ComputerUseError>;
    /// Confirm that no input from this binding/attempt remains in flight. An
    /// SSH disconnect MUST return Uncertain until the target confirms fencing.
    async fn fence(&self, binding: &TargetBinding) -> Result<(), ComputerUseError>;
}

/// Kernel-owned durable journal. Authority checks MUST validate the existing
/// Task/agent Session relationship and workspace; caller labels cannot create it.
pub trait ComputerUseJournal: Send + Sync {
    fn authorize(&self, request: &BindingRequest) -> Result<(), ComputerUseError>;
    fn save_control(&self, state: &ControlState) -> Result<(), ComputerUseError>;
    fn load_controls(&self) -> Result<Vec<ControlState>, ComputerUseError>;
    /// Persist intent/result/fencing events before exposing their effects.
    fn event(
        &self,
        binding_id: &str,
        attempt_id: &str,
        name: &str,
        payload: &serde_json::Value,
    ) -> Result<(), ComputerUseError>;
}
