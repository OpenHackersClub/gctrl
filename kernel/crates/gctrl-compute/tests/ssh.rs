use gctrl_compute::SshCompute;
use gctrl_core::compute::*;
fn config() -> SshComputeConfig {
    SshComputeConfig {
        environment_id: "test-environment".into(),
        ssh_alias: "target-alias".into(),
        ssh_config: None,
        python_path: "/usr/bin/python3".into(),
        helper_path: "/opt/gctrl/supervisor.py".into(),
        state_root: "/var/lib/gctrl/attempts".into(),
        cgroup_root: "/sys/fs/cgroup/gctrl-test".into(),
    }
}
#[test]
fn ssh_configuration_requires_an_explicit_safe_alias_and_absolute_target_tools() {
    assert_eq!(
        SshCompute::new(config()).unwrap().environment_id(),
        "test-environment"
    );
    for alias in [
        "",
        "-oProxyCommand=evil",
        "host;touch pwned",
        "host\nother",
        "user@host",
    ] {
        let mut invalid = config();
        invalid.ssh_alias = alias.into();
        assert!(
            matches!(SshCompute::new(invalid), Err(ComputeError::Invalid { .. })),
            "accepted {alias:?}"
        );
    }
    let mut invalid = config();
    invalid.helper_path = "relative.py".into();
    assert!(matches!(
        SshCompute::new(invalid),
        Err(ComputeError::Invalid { .. })
    ));
    for root in ["", "/", "/sys/fs/cgroup", "/tmp/pretend-cgroup"] {
        let mut invalid = config();
        invalid.cgroup_root = root.into();
        assert!(
            matches!(SshCompute::new(invalid), Err(ComputeError::Invalid { .. })),
            "accepted a target without an explicit delegated cgroup: {root}"
        );
    }
}
#[tokio::test]
async fn malformed_attempt_and_wrong_environment_fail_before_any_ssh_command() {
    let compute = SshCompute::new(config()).unwrap();
    assert!(matches!(
        compute.reconcile("../escape").await,
        Err(ComputeError::Invalid { .. })
    ));
    assert!(matches!(
        compute.cancel("not-a-uuid").await,
        Err(ComputeError::Invalid { .. })
    ));
    let invocation = ComputeInvocation {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        task_id: "task".into(),
        agent_session_id: "session".into(),
        workspace_id: "workspace".into(),
        environment_id: "different-target".into(),
        program: "/bin/true".into(),
        args: vec![],
        cwd: "/tmp".into(),
        stdin: String::new(),
        env: Default::default(),
        timeout_seconds: 30,
    };
    assert!(matches!(
        compute.launch(&invocation).await,
        Err(ComputeError::Invalid { .. })
    ));
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable SSH host; mandatory remote acceptance gate"]
async fn live_ssh_reconciles_the_same_attempt_after_transport_loss_and_confirms_cancel(
) -> Result<(), Box<dyn std::error::Error>> {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};
    fn required(name: &str) -> String {
        std::env::var(name)
            .unwrap_or_else(|_| panic!("set {name} for the owned SSH acceptance target"))
    }
    fn ensure(condition: bool, detail: &str) -> Result<(), Box<dyn std::error::Error>> {
        if condition {
            Ok(())
        } else {
            Err(std::io::Error::other(detail).into())
        }
    }
    let config = SshComputeConfig {
        environment_id: "ssh-live-acceptance".into(),
        ssh_alias: required("GCTRL_LIVE_SSH_ALIAS"),
        ssh_config: Some(required("GCTRL_LIVE_SSH_CONFIG").into()),
        python_path: "/usr/bin/python3".into(),
        helper_path: required("GCTRL_LIVE_COMPUTE_HELPER"),
        state_root: required("GCTRL_LIVE_COMPUTE_STATE"),
        cgroup_root: required("GCTRL_LIVE_COMPUTE_CGROUP"),
    };
    let compute = SshCompute::new(config.clone())?;
    let id = uuid::Uuid::new_v4().to_string();
    let invocation=ComputeInvocation { attempt_id:id.clone(),task_id:"acceptance-task".into(),agent_session_id:"acceptance-session".into(),workspace_id:"acceptance-workspace".into(),environment_id:config.environment_id.clone(),program:"/usr/bin/python3".into(),args:vec!["-c".into(),format!("from pathlib import Path; import time; p=Path('starts-{id}'); p.open('a').write('started\\n'); print('running',flush=True); time.sleep(25); print('finished',flush=True)")],cwd:required("GCTRL_LIVE_COMPUTE_CWD"),stdin:String::new(),env:BTreeMap::from([("PATH".into(),"/usr/bin:/bin".into())]),timeout_seconds:30 };
    let result:Result<(),Box<dyn std::error::Error>>=async {
        let mut delayed=config.clone();delayed.helper_path=required("GCTRL_LIVE_COMPUTE_DELAYED_HELPER");
        let transport_loss=SshCompute::new(delayed)?.launch(&invocation).await;
        ensure(matches!(transport_loss,Err(ComputeError::Uncertain {..})),"lost RPC incorrectly reported a confirmed outcome")?;
        let running=compute.reconcile(&id).await?;
        ensure(running.phase==ComputePhase::Running && running.stdout.contains("running"),"remote process did not survive lost SSH RPC")?;
        let previous_incarnation=running.process_incarnation;
        let duplicate=compute.launch(&invocation).await?;
        ensure(duplicate.process_incarnation==previous_incarnation,"same-attempt resubmission started a replacement")?;
        // Recreate the backend, as after a controller restart; identity comes
        // from durable target state rather than the dead SSH client handle.
        let restarted=SshCompute::new(config.clone())?;
        let resumed=restarted.reconcile(&id).await?;
        ensure(resumed.phase==ComputePhase::Running && resumed.process_incarnation==previous_incarnation,"restart reconciliation lost the live attempt")?;
        ensure(restarted.cancel(&id).await?.phase==ComputePhase::Cancelled,"target did not confirm process-group cancellation")?;
        ensure(restarted.reconcile(&id).await?.phase==ComputePhase::Cancelled,"cancel state was not durable")?;
        let count_id=uuid::Uuid::new_v4().to_string();
        let mut count=invocation.clone();count.attempt_id=count_id.clone();count.args=vec!["-c".into(),format!("from pathlib import Path; print(len(Path('starts-{id}').read_text().splitlines()),flush=True)")];
        compute.launch(&count).await?;
        let deadline=Instant::now()+Duration::from_secs(5);
        loop {
            let result=compute.reconcile(&count_id).await?;
            if result.phase==ComputePhase::Exited {ensure(result.exit_code==Some(0)&&result.stdout.trim()=="1","transport loss caused duplicate remote work")?;break;}
            ensure(Instant::now()<deadline,"count verification did not complete")?;
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let tombstone=uuid::Uuid::new_v4().to_string();
        ensure(compute.cancel(&tombstone).await?.phase==ComputePhase::Cancelled,"cancel-before-launch was not confirmed")?;
        let mut cancelled=invocation.clone();cancelled.attempt_id=tombstone;
        ensure(compute.launch(&cancelled).await?.phase==ComputePhase::Cancelled,"late launch bypassed cancellation tombstone")?;
        Ok(())
    }.await;
    // Always attempt fencing of this owned job before reporting test failure.
    let cleanup = compute.cancel(&id).await;
    if result.is_ok() {
        ensure(
            cleanup?.phase == ComputePhase::Cancelled,
            "cleanup not confirmed",
        )?;
    }
    result?;
    println!("SSH live gate: lost transport, same live attempt after reconnect/restart, exactly one command start, confirmed cancellation, and late-launch fencing");
    Ok(())
}
