use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct OrchConfig {
    /// Agent binary + args. `{prompt}` is *not* interpolated — the prompt
    /// is passed as a separate arg or via stdin (see `agent::spawn`).
    pub agent_cmd: Vec<String>,

    /// Working directory the agent runs in. Defaults to the current process
    /// cwd. Keep this explicit so we never accidentally launch an agent
    /// outside the project root.
    pub working_dir: PathBuf,

    /// Poll interval between queue drains. Short is fine — the query is
    /// indexed and cheap.
    pub poll_interval: Duration,

    /// Max tasks launched per tick. The worker doesn't cap long-running
    /// agents across ticks yet (see `Worker::run_once`) — treat this as
    /// "how greedy is one drain pass."
    pub max_concurrent: usize,

    /// Hard ceiling on agent wall-clock time. A task blown past this is
    /// killed and transitions Running → RetryQueued.
    pub task_timeout: Duration,

    /// If true, don't spawn anything — just log what would happen.
    pub dry_run: bool,
}

impl OrchConfig {
    pub fn default_claude() -> Self {
        Self {
            agent_cmd: vec!["claude".into(), "-p".into()],
            working_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            poll_interval: Duration::from_secs(5),
            max_concurrent: 1,
            task_timeout: Duration::from_secs(60 * 30),
            dry_run: false,
        }
    }
}
