//! Kernel-owned observation, input ownership, takeover, and fencing.
use gctrl_core::computer_use::*;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

#[derive(Default)]
struct Registry {
    controls: HashMap<String, ControlState>,
    desktops: HashMap<DesktopIdentity, DesktopControl>,
    observations: HashMap<String, Proof>,
}
#[derive(Default)]
struct DesktopControl {
    owner: Option<String>,
    generation: Arc<AtomicU64>,
    running: bool,
    blocked: bool,
    settled: Arc<Notify>,
}
struct Proof {
    observation: Observation,
    expires: Instant,
}
struct Permit {
    generation: Arc<AtomicU64>,
    epoch: u64,
}
impl InputPermit for Permit {
    fn check(&self) -> Result<(), ComputerUseError> {
        if self.generation.load(Ordering::SeqCst) == self.epoch {
            Ok(())
        } else {
            Err(ComputerUseError::Interrupted {
                detail: "input ownership revoked".into(),
            })
        }
    }
}
struct RunGuard<'a> {
    coordinator: &'a Coordinator,
    binding: &'a TargetBinding,
    epoch: u64,
    armed: bool,
}
impl<'a> RunGuard<'a> {
    fn new(coordinator: &'a Coordinator, binding: &'a TargetBinding, epoch: u64) -> Self {
        Self {
            coordinator,
            binding,
            epoch,
            armed: true,
        }
    }
    fn finish(&mut self, success: bool, release: bool, error: Option<&ComputerUseError>) {
        if let Ok(mut registry) = self.coordinator.controls() {
            let runtime = registry
                .desktops
                .get_mut(&self.binding.target.desktop)
                .unwrap();
            runtime.running = false;
            runtime.settled.notify_waiters();
            if runtime.generation.load(Ordering::SeqCst) == self.epoch {
                if !success && error.is_some() {
                    runtime.blocked = true;
                    runtime.generation.fetch_add(1, Ordering::SeqCst);
                    let state = registry.controls.get_mut(&self.binding.id).unwrap();
                    state.status = ControlStatus::Uncertain;
                    state.detail = error.map(ToString::to_string);
                    // The runtime remains quarantined even if persistence fails.
                    if let Err(error) = self.coordinator.journal.save_control(state) {
                        tracing::error!(%error, "failed to persist uncertain input control");
                    }
                } else if release || !success {
                    runtime.owner = None;
                    runtime.generation.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        self.armed = false;
    }
}
impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.finish(false, false, Some(&ComputerUseError::Uncertain { detail: "observation/action future interrupted; confirm target fencing before handback".into() }));
        }
    }
}
fn conflict(detail: &str) -> ComputerUseError {
    ComputerUseError::Conflict {
        detail: detail.into(),
    }
}
fn stale(detail: &str) -> ComputerUseError {
    ComputerUseError::Stale {
        detail: detail.into(),
    }
}
fn invalid(detail: &str) -> ComputerUseError {
    ComputerUseError::Invalid {
        detail: detail.into(),
    }
}
fn ensure_ready(state: &ControlState) -> Result<(), ComputerUseError> {
    if state.status == ControlStatus::Ready {
        Ok(())
    } else {
        Err(conflict(
            "binding requires explicit handback or confirmed cancellation",
        ))
    }
}
fn validate_snapshot(
    binding: &TargetBinding,
    snapshot: &TargetSnapshot,
) -> Result<(), ComputerUseError> {
    if snapshot.target != binding.target || snapshot.revision.is_empty() {
        Err(stale(
            "driver did not observe the bound target incarnation/revision",
        ))
    } else {
        Ok(())
    }
}
async fn bounded<T>(
    future: impl std::future::Future<Output = Result<T, ComputerUseError>>,
) -> Result<T, ComputerUseError> {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .map_err(|_| ComputerUseError::Uncertain {
            detail: "target control timed out; outcome unknown".into(),
        })?
}

pub struct Coordinator {
    drivers: HashMap<String, Arc<dyn ComputerUseDriver>>,
    journal: Arc<dyn ComputerUseJournal>,
    controls: Mutex<Registry>,
}
impl Coordinator {
    pub fn new(
        drivers: Vec<Arc<dyn ComputerUseDriver>>,
        journal: Arc<dyn ComputerUseJournal>,
    ) -> Result<Self, ComputerUseError> {
        let mut registry = HashMap::new();
        for driver in drivers {
            let environment = driver.environment_id().to_owned();
            if environment.is_empty() || registry.insert(environment.clone(), driver).is_some() {
                return Err(ComputerUseError::Invalid {
                    detail: format!("empty or duplicate environment id: {environment}"),
                });
            }
        }
        let mut controls = HashMap::new();
        for mut state in journal.load_controls()? {
            // A restored controller cannot infer that a target's old input
            // queue ended. Preserve identity; require target-confirmed fencing.
            if state.status != ControlStatus::Cancelled {
                state.status = ControlStatus::Uncertain;
                state.detail = Some(
                    "controller restarted; fence the previous input attempt before resuming".into(),
                );
                journal.save_control(&state)?;
            }
            controls.insert(state.binding.id.clone(), state);
        }
        let mut desktops = HashMap::<DesktopIdentity, DesktopControl>::new();
        for state in controls.values() {
            if state.status != ControlStatus::Cancelled {
                desktops
                    .entry(state.binding.target.desktop.clone())
                    .or_default()
                    .blocked = true;
            }
        }
        Ok(Self {
            drivers: registry,
            journal,
            controls: Mutex::new(Registry {
                controls,
                desktops,
                observations: HashMap::new(),
            }),
        })
    }
    fn controls(&self) -> Result<MutexGuard<'_, Registry>, ComputerUseError> {
        self.controls.lock().map_err(|_| ComputerUseError::Journal {
            detail: "computer-use control mutex poisoned".into(),
        })
    }
    pub fn status(&self, id: &str) -> Result<ControlState, ComputerUseError> {
        self.controls()?
            .controls
            .get(id)
            .cloned()
            .ok_or_else(|| ComputerUseError::NotFound { id: id.into() })
    }
    fn driver(
        &self,
        binding: &TargetBinding,
    ) -> Result<&Arc<dyn ComputerUseDriver>, ComputerUseError> {
        self.drivers
            .get(&binding.request.environment_id)
            .ok_or_else(|| ComputerUseError::Unsupported {
                detail: format!(
                    "environment {} is no longer available",
                    binding.request.environment_id
                ),
            })
    }
    pub async fn observe(&self, id: &str) -> Result<Observation, ComputerUseError> {
        let binding = self.status(id)?.binding;
        self.journal.authorize(&binding.request)?;
        let (generation, epoch) = {
            let mut registry = self.controls()?;
            ensure_ready(registry.controls.get(id).unwrap())?;
            let runtime = registry
                .desktops
                .entry(binding.target.desktop.clone())
                .or_default();
            if runtime.blocked
                || runtime.running
                || runtime.owner.as_deref().is_some_and(|owner| owner != id)
            {
                return Err(conflict("desktop input is owned, stopped, or uncertain"));
            }
            runtime.owner = Some(id.into());
            let generation = runtime.generation.clone();
            let epoch = generation.fetch_add(1, Ordering::SeqCst) + 1;
            runtime.running = true;
            registry.observations.remove(id);
            (generation, epoch)
        };
        let mut guard = RunGuard::new(self, &binding, epoch);
        let permit = Permit { generation, epoch };
        let result = async {
            let snapshot = bounded(self.driver(&binding)?.observe(&binding.target)).await?;
            permit.check()?;
            validate_snapshot(&binding, &snapshot)?;
            let observation = Observation {
                id: uuid::Uuid::new_v4().to_string(),
                binding_id: id.into(),
                snapshot,
            };
            self.journal
                .event(id, "", "target.observed", &serde_json::json!(&observation))?;
            let mut registry = self.controls()?;
            permit.check()?;
            registry.observations.insert(
                id.into(),
                Proof {
                    observation: observation.clone(),
                    expires: Instant::now() + Duration::from_secs(30),
                },
            );
            Ok(observation)
        }
        .await;
        guard.finish(result.is_ok(), false, result.as_ref().err());
        result
    }
    pub async fn act(
        &self,
        id: &str,
        observation_id: &str,
        steps: Vec<ActionStep>,
    ) -> Result<ActionReceipt, ComputerUseError> {
        if steps.is_empty() || steps.len() > 64 {
            return Err(invalid("actions require 1..=64 steps"));
        }
        for step in &steps {
            match &step.action {
                InputAction::TypeText { text } if text.is_empty() || text.len() > 1024 * 1024 => {
                    return Err(invalid("text must contain 1..=1048576 bytes"))
                }
                InputAction::Key { name } if name.trim().is_empty() || name.len() > 256 => {
                    return Err(invalid("key name is empty or too long"))
                }
                _ => {}
            }
            match &step.expected {
                ExpectedEffect::TextContains { text } if text.is_empty() => {
                    return Err(invalid("expected text must be nonempty"))
                }
                ExpectedEffect::RevisionEquals { revision } if revision.is_empty() => {
                    return Err(invalid("expected revision must be nonempty"))
                }
                _ => {}
            }
        }
        let binding = self.status(id)?.binding;
        self.journal.authorize(&binding.request)?;
        let (proof, generation, epoch) = {
            let mut registry = self.controls()?;
            ensure_ready(registry.controls.get(id).unwrap())?;
            let proof = registry
                .observations
                .get(id)
                .ok_or_else(|| stale("fresh owned observation required"))?;
            if proof.observation.id != observation_id || proof.expires <= Instant::now() {
                return Err(stale(
                    "observation is unknown, expired, or already consumed",
                ));
            }
            let runtime = registry
                .desktops
                .get_mut(&binding.target.desktop)
                .ok_or_else(|| stale("input ownership lost"))?;
            if runtime.blocked || runtime.running || runtime.owner.as_deref() != Some(id) {
                return Err(conflict("desktop input is unavailable"));
            }
            runtime.running = true;
            let generation = runtime.generation.clone();
            let epoch = generation.load(Ordering::SeqCst);
            (registry.observations.remove(id).unwrap(), generation, epoch)
        };
        let mut guard = RunGuard::new(self, &binding, epoch);
        let permit = Permit { generation, epoch };
        let attempt = uuid::Uuid::new_v4().to_string();
        let mut input_started = false;
        let result = async {
            let driver = self.driver(&binding)?;
            let before = bounded(driver.observe(&binding.target)).await?;
            permit.check()?;
            validate_snapshot(&binding, &before)?;
            if before.revision != proof.observation.snapshot.revision { return Err(stale("target content, focus, or input epoch changed since observation")); }
            let mut snapshot = before;
            for (index, step) in steps.iter().enumerate() {
                if index > 0 {
                    let current = bounded(driver.observe(&binding.target)).await?;
                    permit.check()?;
                    validate_snapshot(&binding, &current)?;
                    if current.revision != snapshot.revision {
                        return Err(stale("target changed between verified input steps"));
                    }
                }
                permit.check()?;
                self.journal.event(id, &attempt, "action.intent", &serde_json::json!({"step":index,"action":step.action,"expected":step.expected,"revision":snapshot.revision}))?;
                permit.check()?;
                input_started = true;
                bounded(driver.apply(&binding.target, &step.action, &permit)).await?;
                permit.check()?;
                snapshot = bounded(driver.observe(&binding.target)).await?;
                validate_snapshot(&binding, &snapshot)?;
                let verified = match &step.expected {
                    ExpectedEffect::TextContains { text } => snapshot.text.contains(text),
                    ExpectedEffect::RevisionEquals { revision } => &snapshot.revision == revision,
                };
                if !verified { return Err(ComputerUseError::Verification { detail: format!("step {index} expected effect not observed on the bound target") }); }
                self.journal.event(id, &attempt, "action.verified", &serde_json::json!({"step":index,"snapshot":snapshot}))?;
            }
            permit.check()?;
            Ok(ActionReceipt { attempt_id: attempt.clone(), binding_id: id.into(), verified_steps: steps.len(), final_observation: Observation { id: uuid::Uuid::new_v4().to_string(), binding_id: id.into(), snapshot } })
        }.await;
        if let Err(error) = &result {
            // Record partial/unknown effects. Failure to persist cannot release ownership.
            if self
                .journal
                .event(
                    id,
                    &attempt,
                    "action.uncertain",
                    &serde_json::json!({"error":error,"inputStarted":input_started}),
                )
                .is_err()
            {
                input_started = true;
            }
        }
        guard.finish(
            result.is_ok(),
            true,
            result.as_ref().err().filter(|_| input_started),
        );
        result
    }
    /// Release an unused observation and its desktop lease. In-flight or
    /// uncertain input requires cancellation/fencing rather than release.
    pub fn release(&self, id: &str) -> Result<(), ComputerUseError> {
        let mut registry = self.controls()?;
        let binding = registry
            .controls
            .get(id)
            .ok_or_else(|| ComputerUseError::NotFound { id: id.into() })?
            .binding
            .clone();
        let runtime = registry
            .desktops
            .get_mut(&binding.target.desktop)
            .ok_or_else(|| stale("binding has no input lease"))?;
        if runtime.blocked || runtime.running || runtime.owner.as_deref() != Some(id) {
            return Err(conflict("only an idle confirmed owner may release input"));
        }
        self.journal
            .event(id, "", "input.released", &serde_json::json!({}))?;
        runtime.owner = None;
        runtime.generation.fetch_add(1, Ordering::SeqCst);
        registry.observations.remove(id);
        Ok(())
    }
    pub async fn takeover(&self, id: &str) -> Result<ControlState, ComputerUseError> {
        self.stop(id, true).await
    }
    pub async fn cancel(&self, id: &str) -> Result<ControlState, ComputerUseError> {
        self.stop(id, false).await
    }
    async fn stop(&self, id: &str, human: bool) -> Result<ControlState, ComputerUseError> {
        let binding = self.status(id)?.binding;
        let (affected, epoch) = {
            let mut registry = self.controls()?;
            if registry.controls.get(id).unwrap().status == ControlStatus::Cancelled {
                return Ok(registry.controls.get(id).unwrap().clone());
            }
            let runtime = registry
                .desktops
                .entry(binding.target.desktop.clone())
                .or_default();
            runtime.blocked = true;
            let owner = runtime.owner.clone();
            let epoch = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
            let mut affected = Vec::new();
            for state in registry.controls.values_mut() {
                if state.binding.target.desktop == binding.target.desktop
                    && state.status != ControlStatus::Cancelled
                    && (human
                        || state.binding.id == id
                        || owner.as_deref() == Some(&state.binding.id))
                {
                    state.status = if human {
                        ControlStatus::TakeoverRequested
                    } else {
                        ControlStatus::CancelRequested
                    };
                    state.detail = Some("input revoked; target-confirmed stop pending".into());
                    affected.push(state.clone());
                }
            }
            registry.observations.retain(|_, proof| {
                proof.observation.snapshot.target.desktop != binding.target.desktop
            });
            (affected, epoch)
        };
        for state in &affected {
            self.journal.save_control(state)?;
            self.journal.event(
                &state.binding.id,
                "",
                if human {
                    "takeover.requested"
                } else {
                    "cancel.requested"
                },
                &serde_json::json!({}),
            )?;
        }
        let result: Result<(), ComputerUseError> = async {
            for state in &affected {
                bounded(self.driver(&state.binding)?.fence(&state.binding)).await?;
            }
            bounded(async {
                loop {
                    let notified;
                    {
                        let registry = self.controls()?;
                        let runtime = &registry.desktops[&binding.target.desktop];
                        if !runtime.running {
                            break;
                        }
                        notified = runtime.settled.clone();
                    }
                    // Register before rechecking to avoid a completion between check and wait.
                    let wait = notified.notified();
                    tokio::pin!(wait);
                    wait.as_mut().enable();
                    if !self.controls()?.desktops[&binding.target.desktop].running {
                        break;
                    }
                    wait.await;
                }
                Ok(())
            })
            .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            return Err(ComputerUseError::Uncertain {
                detail: format!("input stop requested but not confirmed: {error}"),
            });
        }
        let mut registry = self.controls()?;
        let runtime = registry.desktops.get_mut(&binding.target.desktop).unwrap();
        if runtime.generation.load(Ordering::SeqCst) != epoch {
            return Err(conflict("input control changed while fencing"));
        }
        // Save confirmations before making this runtime available to any owner.
        for previous in affected {
            let mut state = previous;
            state.status = if human {
                ControlStatus::HumanControl
            } else {
                ControlStatus::Cancelled
            };
            state.detail = None;
            self.journal.save_control(&state)?;
            self.journal.event(
                &state.binding.id,
                "",
                if human {
                    "takeover.confirmed"
                } else {
                    "cancel.confirmed"
                },
                &serde_json::json!({}),
            )?;
            registry.controls.insert(state.binding.id.clone(), state);
        }
        let runtime = registry.desktops.get_mut(&binding.target.desktop).unwrap();
        runtime.owner = None;
        let blocked = human
            || registry.controls.values().any(|state| {
                state.binding.target.desktop == binding.target.desktop
                    && state.status == ControlStatus::Uncertain
            });
        registry
            .desktops
            .get_mut(&binding.target.desktop)
            .unwrap()
            .blocked = blocked;
        Ok(registry.controls.get(id).unwrap().clone())
    }
    /// An explicit handback fences prior control and produces a fresh observation.
    pub async fn resume(&self, id: &str) -> Result<Observation, ComputerUseError> {
        let binding = self.status(id)?.binding;
        self.journal.authorize(&binding.request)?;
        let (affected, epoch) = {
            let registry = self.controls()?;
            let state = registry.controls.get(id).unwrap();
            if !matches!(
                state.status,
                ControlStatus::HumanControl | ControlStatus::Uncertain
            ) {
                return Err(conflict(
                    "explicit handback requires human control or an uncertain stopped binding",
                ));
            }
            let runtime = &registry.desktops[&binding.target.desktop];
            if runtime.running {
                return Err(conflict("old input has not settled"));
            }
            let affected: Vec<_> = registry
                .controls
                .values()
                .filter(|state| {
                    state.binding.target.desktop == binding.target.desktop
                        && state.status != ControlStatus::Cancelled
                })
                .cloned()
                .collect();
            if affected.iter().any(|s| {
                matches!(
                    s.status,
                    ControlStatus::TakeoverRequested | ControlStatus::CancelRequested
                )
            }) {
                return Err(conflict("input stop still awaits confirmation"));
            }
            (affected, runtime.generation.load(Ordering::SeqCst))
        };
        for state in &affected {
            bounded(self.driver(&state.binding)?.fence(&state.binding)).await?;
        }
        {
            let mut registry = self.controls()?;
            if registry.desktops[&binding.target.desktop]
                .generation
                .load(Ordering::SeqCst)
                != epoch
            {
                return Err(conflict("control changed while handing back"));
            }
            for mut state in affected {
                state.status = ControlStatus::Ready;
                state.detail = None;
                self.journal.save_control(&state)?;
                self.journal.event(
                    &state.binding.id,
                    "",
                    "input.handback",
                    &serde_json::json!({}),
                )?;
                registry.controls.insert(state.binding.id.clone(), state);
            }
            let runtime = registry.desktops.get_mut(&binding.target.desktop).unwrap();
            runtime.blocked = false;
            runtime.owner = None;
            runtime.generation.fetch_add(1, Ordering::SeqCst);
        }
        self.observe(id).await
    }
    pub async fn bind(&self, request: BindingRequest) -> Result<ControlState, ComputerUseError> {
        for (name, value) in [
            ("taskId", &request.task_id),
            ("agentSessionId", &request.agent_session_id),
            ("workspaceId", &request.workspace_id),
            ("environmentId", &request.environment_id),
            ("targetId", &request.target_id),
        ] {
            if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control)
            {
                return Err(ComputerUseError::Invalid {
                    detail: format!(
                        "{name} must be a nonempty opaque identity without control characters"
                    ),
                });
            }
        }
        self.journal.authorize(&request)?;
        let driver = self.drivers.get(&request.environment_id).ok_or_else(|| {
            ComputerUseError::NotFound {
                id: request.environment_id.clone(),
            }
        })?;
        let mut matches = driver
            .discover()
            .await?
            .into_iter()
            .filter(|target| target.id == request.target_id);
        let target = matches.next().ok_or_else(|| ComputerUseError::NotFound {
            id: request.target_id.clone(),
        })?;
        if matches.next().is_some() {
            return Err(ComputerUseError::Uncertain {
                detail: "driver returned ambiguous target identity".into(),
            });
        }
        validate_identity(&target)?;
        let state = ControlState {
            binding: TargetBinding {
                id: uuid::Uuid::new_v4().to_string(),
                request,
                target,
            },
            status: ControlStatus::Ready,
            detail: None,
        };
        self.journal.save_control(&state)?;
        self.journal.event(
            &state.binding.id,
            "",
            "binding.created",
            &serde_json::json!(&state.binding),
        )?;
        self.controls()?
            .controls
            .insert(state.binding.id.clone(), state.clone());
        Ok(state)
    }
}

fn validate_identity(target: &TargetIdentity) -> Result<(), ComputerUseError> {
    let mut fields = vec![
        &target.id,
        &target.desktop.host_id,
        &target.desktop.login_session,
        &target.desktop.runtime_id,
    ];
    match &target.application {
        ApplicationIdentity::Window {
            application,
            process_incarnation,
            window_id,
            window_incarnation,
        } => fields.extend([
            application,
            process_incarnation,
            window_id,
            window_incarnation,
        ]),
        ApplicationIdentity::Browser {
            browser_session_id,
            browser_context_id,
            tab_id,
        } => fields.extend([browser_session_id, browser_context_id, tab_id]),
    }
    if fields
        .iter()
        .any(|field| field.trim().is_empty() || field.chars().any(char::is_control))
    {
        return Err(ComputerUseError::Uncertain {
            detail: "driver did not establish a complete host/runtime/application incarnation"
                .into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Journal {
        controls: Mutex<Vec<ControlState>>,
    }
    impl ComputerUseJournal for Journal {
        fn authorize(&self, request: &BindingRequest) -> Result<(), ComputerUseError> {
            if request.task_id == "task"
                && request.agent_session_id == "session"
                && request.workspace_id.starts_with("worktree")
            {
                Ok(())
            } else {
                Err(ComputerUseError::PermissionDenied {
                    detail: "Task/Session/workspace relationship is not authorized".into(),
                })
            }
        }
        fn save_control(&self, state: &ControlState) -> Result<(), ComputerUseError> {
            let mut controls = self.controls.lock().unwrap();
            controls.retain(|s| s.binding.id != state.binding.id);
            controls.push(state.clone());
            Ok(())
        }
        fn load_controls(&self) -> Result<Vec<ControlState>, ComputerUseError> {
            Ok(self.controls.lock().unwrap().clone())
        }
        fn event(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &serde_json::Value,
        ) -> Result<(), ComputerUseError> {
            Ok(())
        }
    }
    struct Driver;
    fn target() -> TargetIdentity {
        TargetIdentity {
            id: "window-token".into(),
            desktop: DesktopIdentity {
                host_id: "host".into(),
                login_session: "login".into(),
                runtime_id: "display-incarnation".into(),
            },
            application: ApplicationIdentity::Window {
                application: "editor".into(),
                process_incarnation: "boot:pid:start".into(),
                window_id: "42".into(),
                window_incarnation: "window-generation".into(),
            },
        }
    }
    #[async_trait]
    impl ComputerUseDriver for Driver {
        fn environment_id(&self) -> &str {
            "environment"
        }
        async fn discover(&self) -> Result<Vec<TargetIdentity>, ComputerUseError> {
            Ok(vec![target()])
        }
        async fn observe(
            &self,
            target: &TargetIdentity,
        ) -> Result<TargetSnapshot, ComputerUseError> {
            Ok(TargetSnapshot {
                target: target.clone(),
                revision: "revision".into(),
                text: "Ready".into(),
                image_base64: None,
            })
        }
        async fn apply(
            &self,
            _: &TargetIdentity,
            _: &InputAction,
            permit: &dyn InputPermit,
        ) -> Result<(), ComputerUseError> {
            permit.check()
        }
        async fn fence(&self, _: &TargetBinding) -> Result<(), ComputerUseError> {
            Ok(())
        }
    }
    fn request() -> BindingRequest {
        BindingRequest {
            task_id: "task".into(),
            agent_session_id: "session".into(),
            workspace_id: "worktree-a".into(),
            environment_id: "environment".into(),
            target_id: "window-token".into(),
        }
    }
    #[tokio::test]
    async fn binding_carries_the_authorized_task_session_workspace_and_real_input_runtime() {
        let journal = Arc::new(Journal::default());
        let coordinator = Coordinator::new(vec![Arc::new(Driver)], journal.clone()).unwrap();
        let state = coordinator.bind(request()).await.unwrap();
        assert_eq!(state.binding.request, request());
        assert_eq!(state.binding.target, target());
        assert_eq!(state.status, ControlStatus::Ready);
        assert_eq!(journal.load_controls().unwrap(), vec![state]);
    }
    #[tokio::test]
    async fn caller_labels_cannot_invent_a_task_session_relationship_or_frontmost_target() {
        let coordinator =
            Coordinator::new(vec![Arc::new(Driver)], Arc::new(Journal::default())).unwrap();
        let mut unauthorized = request();
        unauthorized.agent_session_id = "other-session".into();
        assert!(matches!(
            coordinator.bind(unauthorized).await,
            Err(ComputerUseError::PermissionDenied { .. })
        ));
        let mut positional = request();
        positional.target_id = "frontmost".into();
        assert!(matches!(
            coordinator.bind(positional).await,
            Err(ComputerUseError::NotFound { .. })
        ));
    }
    #[test]
    fn duplicate_environment_ids_are_rejected_and_missing_bindings_are_explicit() {
        let journal = Arc::new(Journal::default());
        assert!(matches!(
            Coordinator::new(vec![Arc::new(Driver), Arc::new(Driver)], journal.clone()),
            Err(ComputerUseError::Invalid { .. })
        ));
        let coordinator = Coordinator::new(vec![Arc::new(Driver)], journal).unwrap();
        assert!(matches!(
            coordinator.status("missing"),
            Err(ComputerUseError::NotFound { .. })
        ));
    }
    #[test]
    fn controller_restart_requires_fencing_before_any_saved_binding_can_resume() {
        let journal = Arc::new(Journal::default());
        let binding = TargetBinding {
            id: "saved-binding".into(),
            request: request(),
            target: target(),
        };
        journal
            .save_control(&ControlState {
                binding: binding.clone(),
                status: ControlStatus::Ready,
                detail: None,
            })
            .unwrap();
        let coordinator = Coordinator::new(vec![Arc::new(Driver)], journal.clone()).unwrap();
        let state = coordinator.status(&binding.id).unwrap();
        assert_eq!(state.status, ControlStatus::Uncertain);
        assert_eq!(journal.load_controls().unwrap(), vec![state]);
    }
}
