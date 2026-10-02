use async_trait::async_trait;
use gctrl_computer_use::Coordinator;
use gctrl_core::computer_use::*;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;

#[derive(Default)]
struct Journal {
    states: Mutex<HashMap<String, ControlState>>,
    events: Mutex<Vec<String>>,
}
impl ComputerUseJournal for Journal {
    fn authorize(&self, _: &BindingRequest) -> Result<(), ComputerUseError> {
        Ok(())
    }
    fn save_control(&self, state: &ControlState) -> Result<(), ComputerUseError> {
        self.states
            .lock()
            .unwrap()
            .insert(state.binding.id.clone(), state.clone());
        Ok(())
    }
    fn load_controls(&self) -> Result<Vec<ControlState>, ComputerUseError> {
        Ok(self.states.lock().unwrap().values().cloned().collect())
    }
    fn event(
        &self,
        _: &str,
        _: &str,
        name: &str,
        _: &serde_json::Value,
    ) -> Result<(), ComputerUseError> {
        self.events.lock().unwrap().push(name.into());
        Ok(())
    }
}
struct Driver {
    environment: String,
    desktop: String,
    text: Mutex<String>,
    revision: AtomicUsize,
    inputs: AtomicUsize,
    hold_input: AtomicBool,
    entered: Notify,
    proceed: Notify,
    fail_fence: AtomicBool,
    human_after_verified: AtomicBool,
}
impl Driver {
    fn new(environment: &str, desktop: &str) -> Self {
        Self {
            environment: environment.into(),
            desktop: desktop.into(),
            text: Mutex::new("Ready".into()),
            revision: 0.into(),
            inputs: 0.into(),
            hold_input: false.into(),
            entered: Notify::new(),
            proceed: Notify::new(),
            fail_fence: false.into(),
            human_after_verified: false.into(),
        }
    }
    fn target(&self) -> TargetIdentity {
        TargetIdentity {
            id: "window".into(),
            desktop: DesktopIdentity {
                host_id: "host".into(),
                login_session: "login".into(),
                runtime_id: self.desktop.clone(),
            },
            application: ApplicationIdentity::Window {
                application: "editor".into(),
                process_incarnation: "boot:pid:start".into(),
                window_id: "42".into(),
                window_incarnation: "nonce".into(),
            },
        }
    }
}
#[async_trait]
impl ComputerUseDriver for Driver {
    fn environment_id(&self) -> &str {
        &self.environment
    }
    async fn discover(&self) -> Result<Vec<TargetIdentity>, ComputerUseError> {
        Ok(vec![self.target()])
    }
    async fn observe(&self, _: &TargetIdentity) -> Result<TargetSnapshot, ComputerUseError> {
        let snapshot = TargetSnapshot {
            target: self.target(),
            text: self.text.lock().unwrap().clone(),
            revision: self.revision.load(Ordering::SeqCst).to_string(),
            image_base64: None,
        };
        if self.inputs.load(Ordering::SeqCst) == 2
            && self.human_after_verified.swap(false, Ordering::SeqCst)
        {
            *self.text.lock().unwrap() = "human changed between steps".into();
            self.revision.fetch_add(1, Ordering::SeqCst);
        }
        Ok(snapshot)
    }
    async fn apply(
        &self,
        _: &TargetIdentity,
        action: &InputAction,
        permit: &dyn InputPermit,
    ) -> Result<(), ComputerUseError> {
        permit.check()?;
        self.inputs.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.hold_input.load(Ordering::SeqCst) {
            self.proceed.notified().await;
        }
        // A driver must check again before its next atom, even within one step.
        permit.check()?;
        self.inputs.fetch_add(1, Ordering::SeqCst);
        if let InputAction::TypeText { text } = action {
            *self.text.lock().unwrap() = text.clone();
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn fence(&self, _: &TargetBinding) -> Result<(), ComputerUseError> {
        if self.fail_fence.load(Ordering::SeqCst) {
            Err(ComputerUseError::Uncertain {
                detail: "SSH connection lost; target cannot confirm fencing".into(),
            })
        } else {
            Ok(())
        }
    }
}
fn request(environment: &str, workspace: &str) -> BindingRequest {
    BindingRequest {
        task_id: "task".into(),
        agent_session_id: "session".into(),
        workspace_id: workspace.into(),
        environment_id: environment.into(),
        target_id: "window".into(),
    }
}
fn step(text: &str) -> ActionStep {
    ActionStep {
        action: InputAction::TypeText { text: text.into() },
        expected: ExpectedEffect::TextContains { text: text.into() },
    }
}
fn setup(drivers: Vec<Arc<Driver>>) -> (Arc<Coordinator>, Arc<Journal>) {
    let journal = Arc::new(Journal::default());
    let coordinator = Arc::new(
        Coordinator::new(
            drivers
                .into_iter()
                .map(|d| d as Arc<dyn ComputerUseDriver>)
                .collect(),
            journal.clone(),
        )
        .unwrap(),
    );
    (coordinator, journal)
}
#[tokio::test]
async fn worktrees_on_one_desktop_share_the_input_owner_and_independent_desktops_do_not() {
    let (c, _) = setup(vec![
        Arc::new(Driver::new("a", "display")),
        Arc::new(Driver::new("b", "display")),
        Arc::new(Driver::new("vm", "vm-display")),
    ]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let b = c.bind(request("b", "worktree-b")).await.unwrap();
    let vm = c.bind(request("vm", "worktree-vm")).await.unwrap();
    let observation = c.observe(&a.binding.id).await.unwrap();
    assert!(matches!(
        c.observe(&b.binding.id).await,
        Err(ComputerUseError::Conflict { .. })
    ));
    assert!(c.observe(&vm.binding.id).await.is_ok());
    let receipt = c
        .act(&a.binding.id, &observation.id, vec![step("saved")])
        .await
        .unwrap();
    assert_eq!(receipt.verified_steps, 1);
    assert_eq!(receipt.final_observation.snapshot.text, "saved");
    assert!(c.observe(&b.binding.id).await.is_ok());
    c.release(&b.binding.id).unwrap();
    c.release(&vm.binding.id).unwrap();
}
#[tokio::test]
async fn stale_single_use_observations_stop_input_and_success_requires_expected_effect() {
    let driver = Arc::new(Driver::new("a", "display"));
    let (c, journal) = setup(vec![driver.clone()]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let id = &a.binding.id;
    let observation = c.observe(id).await.unwrap();
    driver.revision.fetch_add(1, Ordering::SeqCst);
    assert!(matches!(
        c.act(id, &observation.id, vec![step("wrong")]).await,
        Err(ComputerUseError::Stale { .. })
    ));
    assert_eq!(driver.inputs.load(Ordering::SeqCst), 0);
    let fresh = c.observe(id).await.unwrap();
    let bad = ActionStep {
        action: InputAction::TypeText {
            text: "actual".into(),
        },
        expected: ExpectedEffect::TextContains {
            text: "missing".into(),
        },
    };
    assert!(matches!(
        c.act(id, &fresh.id, vec![bad]).await,
        Err(ComputerUseError::Verification { .. })
    ));
    assert_eq!(c.status(id).unwrap().status, ControlStatus::Uncertain);
    assert!(c.observe(id).await.is_err());
    let resumed = c.resume(id).await.unwrap();
    assert_eq!(resumed.snapshot.text, "actual");
    assert!(matches!(
        c.act(id, &fresh.id, vec![step("replay")]).await,
        Err(ComputerUseError::Stale { .. })
    ));
    assert_eq!(driver.inputs.load(Ordering::SeqCst), 2);
    assert!(journal
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|name| name == "action.uncertain"));
}
#[tokio::test]
async fn takeover_interrupts_atoms_and_requires_explicit_fresh_handback() {
    let driver = Arc::new(Driver::new("a", "display"));
    driver.hold_input.store(true, Ordering::SeqCst);
    let (c, _) = setup(vec![driver.clone()]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let observation = c.observe(&a.binding.id).await.unwrap();
    let action = {
        let c = c.clone();
        let id = a.binding.id.clone();
        tokio::spawn(async move {
            c.act(&id, &observation.id, vec![step("first"), step("second")])
                .await
        })
    };
    driver.entered.notified().await;
    let takeover = {
        let c = c.clone();
        let id = a.binding.id.clone();
        tokio::spawn(async move { c.takeover(&id).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while c.status(&a.binding.id).unwrap().status != ControlStatus::TakeoverRequested {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(c.observe(&a.binding.id).await.is_err());
    driver.proceed.notify_one();
    assert!(matches!(
        action.await.unwrap(),
        Err(ComputerUseError::Interrupted { .. })
    ));
    assert_eq!(driver.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(
        takeover.await.unwrap().unwrap().status,
        ControlStatus::HumanControl
    );
    *driver.text.lock().unwrap() = "human edit".into();
    driver.revision.fetch_add(1, Ordering::SeqCst);
    let handback = c.resume(&a.binding.id).await.unwrap();
    assert_eq!(handback.snapshot.text, "human edit");
    driver.hold_input.store(false, Ordering::SeqCst);
    assert!(c
        .act(&a.binding.id, &handback.id, vec![step("after handback")])
        .await
        .is_ok());
}
#[tokio::test]
async fn unconfirmed_cancel_retains_desktop_ownership_until_target_acknowledges_stop() {
    let driver = Arc::new(Driver::new("a", "display"));
    let other = Arc::new(Driver::new("b", "display"));
    let (c, _) = setup(vec![driver.clone(), other]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let b = c.bind(request("b", "worktree-b")).await.unwrap();
    c.observe(&a.binding.id).await.unwrap();
    driver.fail_fence.store(true, Ordering::SeqCst);
    assert!(matches!(
        c.cancel(&a.binding.id).await,
        Err(ComputerUseError::Uncertain { .. })
    ));
    assert_eq!(
        c.status(&a.binding.id).unwrap().status,
        ControlStatus::CancelRequested
    );
    assert!(c.observe(&b.binding.id).await.is_err());
    driver.fail_fence.store(false, Ordering::SeqCst);
    assert_eq!(
        c.cancel(&a.binding.id).await.unwrap().status,
        ControlStatus::Cancelled
    );
    assert!(c.observe(&b.binding.id).await.is_ok());
    assert!(c.observe(&a.binding.id).await.is_err());
}

#[tokio::test]
async fn dropping_an_inflight_action_quarantines_input_until_explicit_fencing() {
    let driver = Arc::new(Driver::new("a", "display"));
    driver.hold_input.store(true, Ordering::SeqCst);
    let (c, journal) = setup(vec![driver.clone()]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let observation = c.observe(&a.binding.id).await.unwrap();
    let action = {
        let c = c.clone();
        let id = a.binding.id.clone();
        tokio::spawn(async move { c.act(&id, &observation.id, vec![step("interrupted")]).await })
    };
    driver.entered.notified().await;
    action.abort();
    assert!(action.await.unwrap_err().is_cancelled());
    assert_eq!(
        c.status(&a.binding.id).unwrap().status,
        ControlStatus::Uncertain
    );
    assert_eq!(
        journal.states.lock().unwrap()[&a.binding.id].status,
        ControlStatus::Uncertain
    );
    assert!(c.release(&a.binding.id).is_err());
    assert!(c.observe(&a.binding.id).await.is_err());
    assert_eq!(driver.inputs.load(Ordering::SeqCst), 1);
    let handback = c.resume(&a.binding.id).await.unwrap();
    assert_eq!(handback.snapshot.text, "Ready");
    c.release(&a.binding.id).unwrap();
}
#[tokio::test]
async fn restored_uncertain_desktop_blocks_new_bindings_and_resume_observes_again() {
    let driver = Arc::new(Driver::new("a", "display"));
    let (old, journal) = setup(vec![driver.clone()]);
    let a = old.bind(request("a", "worktree-a")).await.unwrap();
    let observation = old.observe(&a.binding.id).await.unwrap();
    drop(old);
    let restored = Coordinator::new(vec![driver], journal).unwrap();
    let b = restored.bind(request("a", "worktree-b")).await.unwrap();
    assert!(restored.observe(&b.binding.id).await.is_err());
    let handback = restored.resume(&a.binding.id).await.unwrap();
    assert_ne!(handback.id, observation.id);
    assert!(matches!(
        restored
            .act(&a.binding.id, &observation.id, vec![step("replay")])
            .await,
        Err(ComputerUseError::Stale { .. })
    ));
    restored.release(&a.binding.id).unwrap();
    assert!(restored.observe(&b.binding.id).await.is_ok());
}
#[tokio::test]
async fn invalid_batch_cannot_consume_the_owned_observation() {
    let (c, _) = setup(vec![Arc::new(Driver::new("a", "display"))]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let observation = c.observe(&a.binding.id).await.unwrap();
    assert!(matches!(
        c.act(&a.binding.id, &observation.id, vec![]).await,
        Err(ComputerUseError::Invalid { .. })
    ));
    assert!(c
        .act(&a.binding.id, &observation.id, vec![step("valid")])
        .await
        .is_ok());
    assert!(matches!(
        c.act(&a.binding.id, &observation.id, vec![step("replay")])
            .await,
        Err(ComputerUseError::Stale { .. })
    ));
}

#[tokio::test]
async fn human_edits_between_verified_steps_stop_the_next_step() {
    let driver = Arc::new(Driver::new("a", "display"));
    driver.human_after_verified.store(true, Ordering::SeqCst);
    let (c, _) = setup(vec![driver.clone()]);
    let a = c.bind(request("a", "worktree-a")).await.unwrap();
    let observation = c.observe(&a.binding.id).await.unwrap();
    assert!(matches!(
        c.act(
            &a.binding.id,
            &observation.id,
            vec![step("first"), step("second")]
        )
        .await,
        Err(ComputerUseError::Stale { .. })
    ));
    assert_eq!(driver.inputs.load(Ordering::SeqCst), 2);
    assert_eq!(
        c.status(&a.binding.id).unwrap().status,
        ControlStatus::Uncertain
    );
    assert_eq!(*driver.text.lock().unwrap(), "human changed between steps");
}
