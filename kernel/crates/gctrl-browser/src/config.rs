use std::path::PathBuf;

/// Daemon-wide browser pool configuration. Loaded from
/// `~/.config/gctrl/config.toml` `[browser]` section by the daemon (config
/// file parsing is owned by the daemon binary, not this crate). Env vars
/// override file values for ops convenience.
#[derive(Debug, Clone)]
pub struct BrowserConfig {
    pub pool_max: u32,
    pub contexts_per_chromium_max: u32,
    /// Recycle a Chromium when it has been idle (zero active sessions) for
    /// at least this many seconds. Default 1800 (30 min).
    pub recycle_idle_seconds: u64,
    /// Recycle a Chromium when its absolute age reaches this many seconds,
    /// regardless of activity, via graceful drain. Default 28800 (8 h).
    pub recycle_max_age_seconds: u64,
    /// Default session TTL when the request doesn't override.
    pub default_ttl_seconds: u32,
    /// Default recording byte cap when the request doesn't override.
    pub default_recording_max_bytes: u64,
    /// Path to a Chromium binary; empty means autodetect via `which`.
    pub chromium_path: Option<PathBuf>,
    /// Whether headed mode is permitted. PR1 always returns `false` to
    /// reflect the stub state; PR2 will read from config.
    pub headed_default: bool,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        BrowserConfig {
            pool_max: 4,
            contexts_per_chromium_max: 8,
            recycle_idle_seconds: 1800,
            recycle_max_age_seconds: 28_800,
            default_ttl_seconds: 600,
            default_recording_max_bytes: 50 * 1024 * 1024,
            chromium_path: None,
            headed_default: false,
        }
    }
}

impl BrowserConfig {
    /// Apply env var overrides on top of an existing config.
    pub fn with_env_overrides(mut self) -> Self {
        if let Ok(v) = std::env::var("GCTRL_BROWSER_POOL_MAX") {
            if let Ok(v) = v.parse::<u32>() {
                self.pool_max = v;
            }
        }
        if let Ok(v) = std::env::var("GCTRL_BROWSER_RECYCLE_IDLE_SECS") {
            if let Ok(v) = v.parse::<u64>() {
                self.recycle_idle_seconds = v;
            }
        }
        if let Ok(v) = std::env::var("GCTRL_BROWSER_RECYCLE_MAX_AGE_SECS") {
            if let Ok(v) = v.parse::<u64>() {
                self.recycle_max_age_seconds = v;
            }
        }
        if let Ok(v) = std::env::var("GCTRL_BROWSER_DEFAULT_TTL_SECS") {
            if let Ok(v) = v.parse::<u32>() {
                self.default_ttl_seconds = v;
            }
        }
        if let Ok(v) = std::env::var("GCTRL_BROWSER_CHROMIUM_PATH") {
            if !v.is_empty() {
                self.chromium_path = Some(PathBuf::from(v));
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec() {
        let c = BrowserConfig::default();
        assert_eq!(c.pool_max, 4);
        assert_eq!(c.contexts_per_chromium_max, 8);
        assert_eq!(c.recycle_idle_seconds, 1800);
        assert_eq!(c.recycle_max_age_seconds, 28_800);
        assert_eq!(c.default_ttl_seconds, 600);
        assert_eq!(c.default_recording_max_bytes, 50 * 1024 * 1024);
        assert!(!c.headed_default);
        assert!(c.chromium_path.is_none());
    }
}
