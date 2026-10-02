//! Ordinary OpenSSH attachment to durable execution and target-host tooling.
use gctrl_core::compute::{
    ComputeError, ComputeInvocation, ComputePhase, ComputeSnapshot, ComputeSubstrate,
    SshComputeConfig, TargetHostPort,
};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub struct SshHost {
    config: SshComputeConfig,
}
impl SshHost {
    pub fn new(config: SshComputeConfig) -> Result<Self, ComputeError> {
        validate_config(&config)?;
        Ok(Self { config })
    }
}
#[async_trait::async_trait]
impl TargetHostPort for SshHost {
    fn environment_id(&self) -> &str {
        &self.config.environment_id
    }
    async fn request(
        &self,
        helper_path: &str,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, ComputeError> {
        absolute_path(helper_path)?;
        let input =
            serde_json::to_vec(payload).map_err(|e| invalid(&format!("request JSON: {e}")))?;
        if input.len() > 4 * 1024 * 1024 {
            return Err(invalid("target-host request exceeds 4 MiB"));
        }
        let mut command = Command::new("ssh");
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ConnectTimeout=5",
        ]);
        if let Some(path) = &self.config.ssh_config {
            command.arg("-F").arg(path);
        }
        command.arg("--").arg(&self.config.ssh_alias).arg(format!(
            "{} {}",
            quote(&self.config.python_path),
            quote(helper_path)
        ));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let request = async {
            let mut child = command.spawn().map_err(|e| ComputeError::Unsupported {
                detail: format!("spawn ordinary OpenSSH client: {e}"),
            })?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| uncertain("SSH stdin unavailable"))?;
            stdin
                .write_all(&input)
                .await
                .map_err(|e| uncertain(&format!("SSH request send failed: {e}")))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| uncertain(&format!("SSH request EOF failed: {e}")))?;
            drop(stdin);
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| uncertain("SSH stdout unavailable"))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| uncertain("SSH stderr unavailable"))?;
            let read_output = async {
                let mut bytes = Vec::new();
                stdout
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map(|_| bytes)
            };
            let read_error = async {
                let mut bytes = Vec::new();
                stderr
                    .take(64 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map(|_| bytes)
            };
            let (output, error, status) = tokio::join!(read_output, read_error, child.wait());
            let output =
                output.map_err(|e| uncertain(&format!("SSH response read failed: {e}")))?;
            let error =
                error.map_err(|e| uncertain(&format!("SSH diagnostic read failed: {e}")))?;
            let status = status.map_err(|e| uncertain(&format!("SSH wait failed: {e}")))?;
            if !status.success() {
                return Err(uncertain(&format!(
                    "SSH connection/command ended without a confirmed target outcome ({}): {}",
                    status,
                    String::from_utf8_lossy(&error)
                )));
            }
            if output.len() > 4 * 1024 * 1024 {
                return Err(uncertain("target response exceeds 4 MiB"));
            }
            let value: serde_json::Value = serde_json::from_slice(&output)
                .map_err(|e| uncertain(&format!("target response JSON: {e}")))?;
            if let Some(error) = value.get("error") {
                return Err(serde_json::from_value(error.clone())
                    .map_err(|e| uncertain(&format!("target error schema: {e}")))?);
            }
            Ok(value)
        };
        tokio::time::timeout(Duration::from_secs(12), request)
            .await
            .map_err(|_| {
                uncertain("SSH request timed out; remote execution may still be running")
            })?
    }
}

pub struct SshCompute {
    config: SshComputeConfig,
    host: Arc<dyn TargetHostPort>,
}
impl SshCompute {
    pub fn new(config: SshComputeConfig) -> Result<Self, ComputeError> {
        let host = Arc::new(SshHost::new(config.clone())?);
        Ok(Self { config, host })
    }
    async fn request(
        &self,
        id: &str,
        payload: serde_json::Value,
    ) -> Result<ComputeSnapshot, ComputeError> {
        validate_attempt(id)?;
        let value = self
            .host
            .request(&self.config.helper_path, &payload)
            .await?;
        let snapshot: ComputeSnapshot = serde_json::from_value(value)
            .map_err(|e| uncertain(&format!("compute snapshot schema: {e}")))?;
        if snapshot.attempt_id != id
            || snapshot.host_id.is_empty()
            || (snapshot.phase == ComputePhase::Running
                && snapshot
                    .process_incarnation
                    .as_deref()
                    .is_none_or(str::is_empty))
            || (snapshot.phase == ComputePhase::Exited && snapshot.exit_code.is_none())
        {
            return Err(uncertain(
                "target did not confirm the expected attempt/host/process/exit identity",
            ));
        }
        Ok(snapshot)
    }
}
#[async_trait::async_trait]
impl ComputeSubstrate for SshCompute {
    fn environment_id(&self) -> &str {
        &self.config.environment_id
    }
    async fn launch(
        &self,
        invocation: &ComputeInvocation,
    ) -> Result<ComputeSnapshot, ComputeError> {
        if invocation.environment_id != self.config.environment_id {
            return Err(invalid(
                "invocation environment does not match the selected SSH target",
            ));
        }
        let snapshot = self.request(&invocation.attempt_id,serde_json::json!({"operation":"launch","stateRoot":self.config.state_root,"cgroupRoot":self.config.cgroup_root,"invocation":invocation})).await?;
        let fingerprint = invocation.fingerprint()?;
        if snapshot.invocation_hash.as_deref() != Some(fingerprint.as_str())
            && !(snapshot.phase == ComputePhase::Cancelled && snapshot.invocation_hash.is_none())
        {
            return Err(uncertain("launch receipt belongs to another invocation"));
        }
        Ok(snapshot)
    }
    async fn reconcile(&self, attempt_id: &str) -> Result<ComputeSnapshot, ComputeError> {
        self.request(attempt_id,serde_json::json!({"operation":"reconcile","stateRoot":self.config.state_root,"cgroupRoot":self.config.cgroup_root,"attemptId":attempt_id})).await
    }
    async fn cancel(&self, attempt_id: &str) -> Result<ComputeSnapshot, ComputeError> {
        self.request(attempt_id,serde_json::json!({"operation":"cancel","stateRoot":self.config.state_root,"cgroupRoot":self.config.cgroup_root,"attemptId":attempt_id})).await
    }
}
fn invalid(detail: &str) -> ComputeError {
    ComputeError::Invalid {
        detail: detail.into(),
    }
}
fn uncertain(detail: &str) -> ComputeError {
    ComputeError::Uncertain {
        detail: detail.into(),
    }
}
fn validate_attempt(id: &str) -> Result<(), ComputeError> {
    if uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) {
        Ok(())
    } else {
        Err(invalid("attempt identity must be a canonical UUID"))
    }
}
fn absolute_path(path: &str) -> Result<(), ComputeError> {
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        Err(invalid(
            "target-host paths must be absolute without control characters",
        ))
    } else {
        Ok(())
    }
}
fn validate_config(config: &SshComputeConfig) -> Result<(), ComputeError> {
    if config.environment_id.trim().is_empty()
        || config.environment_id.chars().any(char::is_control)
    {
        return Err(invalid("environment identity is empty or invalid"));
    }
    let alias = &config.ssh_alias;
    if alias.len() > 256
        || !alias
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        || !alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid("use an explicit OpenSSH configuration alias"));
    }
    for path in [&config.python_path, &config.helper_path, &config.state_root] {
        absolute_path(path)?;
    }
    absolute_path(&config.cgroup_root)?;
    if !config.cgroup_root.starts_with("/sys/fs/cgroup/") {
        return Err(invalid(
            "target requires an explicit delegated cgroup-v2 subtree",
        ));
    }
    Ok(())
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Host(serde_json::Value);
    #[async_trait::async_trait]
    impl TargetHostPort for Host {
        fn environment_id(&self) -> &str {
            "test"
        }
        async fn request(
            &self,
            _: &str,
            _: &serde_json::Value,
        ) -> Result<serde_json::Value, ComputeError> {
            Ok(self.0.clone())
        }
    }
    fn compute(response: serde_json::Value) -> SshCompute {
        SshCompute {
            config: SshComputeConfig {
                environment_id: "test".into(),
                ssh_alias: "target".into(),
                ssh_config: None,
                python_path: "/usr/bin/python3".into(),
                helper_path: "/helper.py".into(),
                state_root: "/state".into(),
                cgroup_root: "/sys/fs/cgroup/gctrl-test".into(),
            },
            host: Arc::new(Host(response)),
        }
    }
    fn snapshot(id: &str) -> serde_json::Value {
        serde_json::json!({"attemptId":id,"invocationHash":"hash","hostId":"machine:boot","processIncarnation":"machine:boot:pid:start","phase":"running","exitCode":null,"stdout":"partial","stderr":"","detail":null})
    }
    #[tokio::test]
    async fn launch_requires_the_receipt_for_this_exact_invocation() {
        let invocation = ComputeInvocation {
            attempt_id: uuid::Uuid::new_v4().to_string(),
            task_id: "task".into(),
            agent_session_id: "session".into(),
            workspace_id: "workspace".into(),
            environment_id: "test".into(),
            program: "/bin/echo".into(),
            args: vec!["héllo 🌍".into()],
            cwd: "/target".into(),
            stdin: String::new(),
            env: Default::default(),
            timeout_seconds: 30,
        };
        let mut response = snapshot(&invocation.attempt_id);
        assert!(matches!(
            compute(response.clone()).launch(&invocation).await,
            Err(ComputeError::Uncertain { .. })
        ));
        response["invocationHash"] = serde_json::json!(invocation.fingerprint().unwrap());
        assert_eq!(
            compute(response.clone())
                .launch(&invocation)
                .await
                .unwrap()
                .phase,
            ComputePhase::Running
        );
        response["phase"] = serde_json::json!("cancelled");
        response["invocationHash"] = serde_json::Value::Null;
        response["processIncarnation"] = serde_json::Value::Null;
        assert_eq!(
            compute(response).launch(&invocation).await.unwrap().phase,
            ComputePhase::Cancelled
        );
    }
    #[tokio::test]
    async fn mismatched_or_incomplete_target_responses_are_uncertain_not_confirmed_execution() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            compute(snapshot("different")).reconcile(&id).await,
            Err(ComputeError::Uncertain { .. })
        ));
        let mut missing = snapshot(&id);
        missing["processIncarnation"] = serde_json::Value::Null;
        assert!(matches!(
            compute(missing).reconcile(&id).await,
            Err(ComputeError::Uncertain { .. })
        ));
        let mut missing_exit = snapshot(&id);
        missing_exit["phase"] = serde_json::json!("exited");
        assert!(matches!(
            compute(missing_exit).reconcile(&id).await,
            Err(ComputeError::Uncertain { .. })
        ));
        assert_eq!(
            compute(snapshot(&id)).reconcile(&id).await.unwrap().stdout,
            "partial"
        );
    }
    #[test]
    fn configured_target_paths_are_shell_quoted_without_interpreting_their_contents() {
        assert_eq!(
            quote("/tmp/a'b$(touch ignored)"),
            "'/tmp/a'\"'\"'b$(touch ignored)'"
        );
    }
}
