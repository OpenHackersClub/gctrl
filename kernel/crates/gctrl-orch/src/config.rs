use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct OrchConfig {
    /// Agent binary + args. `{prompt}` is *not* interpolated — the prompt
    /// is passed on stdin (see `agent::spawn_agent`).
    pub agent_cmd: Vec<String>,

    /// Working directory the agent runs in. Defaults to the current process
    /// cwd. Keep this explicit so we never accidentally launch an agent
    /// outside the project root.
    pub working_dir: PathBuf,

    /// Poll interval between queue drains. Short is fine — the query is
    /// indexed and cheap.
    pub poll_interval: Duration,

    /// Max tasks dispatched per drain pass. The worker runs them
    /// sequentially within a pass today; this is a batch size, not true
    /// concurrency.
    pub max_per_pass: usize,

    /// Hard ceiling on agent wall-clock time. A task blown past this is
    /// killed and transitions Running → RetryQueued.
    pub task_timeout: Duration,

    /// If true, don't spawn anything — just log what would happen and
    /// return the task to the Unclaimed pool.
    pub dry_run: bool,
}
