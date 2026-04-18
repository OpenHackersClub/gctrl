use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GctlConfig {
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub otel: OtelConfig,
    #[serde(default)]
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub sync: SyncConfig,
    #[serde(default)]
    pub guardrails: GuardrailsConfig,
    #[serde(default)]
    pub net: NetConfig,
}

impl Default for GctlConfig {
    fn default() -> Self {
        Self {
            storage: StorageConfig::default(),
            otel: OtelConfig::default(),
            proxy: ProxyConfig::default(),
            sync: SyncConfig::default(),
            guardrails: GuardrailsConfig::default(),
            net: NetConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    pub db_path: PathBuf,
    pub retention_days: u32,
}

impl Default for StorageConfig {
    fn default() -> Self {
        let data_dir = dirs_default_data().join("gctrl");
        Self {
            db_path: data_dir.join("gctrl.duckdb"),
            retention_days: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtelConfig {
    pub listen_port: u16,
    pub listen_host: String,
}

impl Default for OtelConfig {
    fn default() -> Self {
        Self {
            listen_port: 4318,
            listen_host: "127.0.0.1".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub listen_port: u16,
    pub allowed_domains: Vec<String>,
    pub rate_limit_rps: Option<u32>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            listen_port: 8080,
            allowed_domains: vec![],
            rate_limit_rps: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub device_id: String,
    #[serde(default)]
    pub auto_pull: bool,

    // R2 — DuckDB sync target (telemetry, spans, sessions)
    pub r2_bucket: String,
    pub r2_endpoint: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,

    // D1 — SQLite sync target (board, tasks, app state)
    // Credentials: CLI flags > env vars (GCTL_D1_DATABASE_ID, GCTL_D1_ACCOUNT_ID,
    // GCTL_D1_API_TOKEN) > config file.
    #[serde(default)]
    pub d1_database_id: String,
    #[serde(default)]
    pub d1_account_id: String,
    #[serde(default)]
    pub d1_api_token: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_seconds: 300,
            device_id: String::new(),
            auto_pull: false,
            r2_bucket: String::new(),
            r2_endpoint: String::new(),
            r2_access_key_id: String::new(),
            r2_secret_access_key: String::new(),
            d1_database_id: String::new(),
            d1_account_id: String::new(),
            d1_api_token: String::new(),
        }
    }
}

impl SyncConfig {
    /// Returns true if D1 sync is configured (all three fields non-empty).
    pub fn d1_enabled(&self) -> bool {
        !self.d1_database_id.is_empty()
            && !self.d1_account_id.is_empty()
            && !self.d1_api_token.is_empty()
    }

    /// Populate D1 credentials from env vars (GCTL_D1_DATABASE_ID,
    /// GCTL_D1_ACCOUNT_ID, GCTL_D1_API_TOKEN). Returns a config with
    /// `enabled=true` iff all three are set.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if let Ok(v) = std::env::var("GCTL_D1_DATABASE_ID") {
            cfg.d1_database_id = v;
        }
        if let Ok(v) = std::env::var("GCTL_D1_ACCOUNT_ID") {
            cfg.d1_account_id = v;
        }
        if let Ok(v) = std::env::var("GCTL_D1_API_TOKEN") {
            cfg.d1_api_token = v;
        }
        if let Ok(v) = std::env::var("GCTL_DEVICE_ID") {
            cfg.device_id = v;
        }
        cfg.enabled = cfg.d1_enabled();
        cfg
    }
}

/// External network-driver credentials (Brave Search, Cloudflare Browser Rendering).
/// Populated from env vars at daemon startup; missing fields return 503 from the
/// matching HTTP route.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetConfig {
    #[serde(default)]
    pub brave_api_key: Option<String>,
    #[serde(default)]
    pub cf_account_id: Option<String>,
    #[serde(default)]
    pub cf_api_token: Option<String>,
}

impl NetConfig {
    pub fn from_env() -> Self {
        Self {
            brave_api_key: std::env::var("BRAVE_SEARCH_API_KEY").ok().filter(|s| !s.is_empty()),
            cf_account_id: std::env::var("CF_ACCOUNT_ID").ok().filter(|s| !s.is_empty()),
            cf_api_token: std::env::var("CF_API_TOKEN").ok().filter(|s| !s.is_empty()),
        }
    }

    pub fn cf_browser_enabled(&self) -> bool {
        self.cf_account_id.is_some() && self.cf_api_token.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardrailsConfig {
    pub session_budget_usd: Option<f64>,
    pub max_diff_lines: Option<u32>,
    pub loop_detection_threshold: u32,
    pub blocked_commands: Vec<String>,
    pub allow_raw_sql: bool,
    pub max_query_rows: u32,
    pub blocked_columns: Vec<String>,
}

impl Default for GuardrailsConfig {
    fn default() -> Self {
        Self {
            session_budget_usd: None,
            max_diff_lines: None,
            loop_detection_threshold: 5,
            blocked_commands: vec![
                "rm -rf /".into(),
                "git push --force origin main".into(),
            ],
            allow_raw_sql: false,
            max_query_rows: 1000,
            blocked_columns: vec![],
        }
    }
}

fn dirs_default_data() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".local/share")
    } else {
        PathBuf::from("/tmp")
    }
}

impl GctlConfig {
    pub fn config_path() -> PathBuf {
        if let Some(home) = std::env::var_os("HOME") {
            PathBuf::from(home).join(".config/gctrl/config.toml")
        } else {
            PathBuf::from("/tmp/gctrl/config.toml")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let cfg = GctlConfig::default();
        assert_eq!(cfg.otel.listen_port, 4318);
        assert_eq!(cfg.proxy.listen_port, 8080);
        assert_eq!(cfg.storage.retention_days, 30);
        assert!(!cfg.guardrails.allow_raw_sql);
        assert_eq!(cfg.guardrails.loop_detection_threshold, 5);
        assert_eq!(cfg.guardrails.max_query_rows, 1000);
    }

    #[test]
    fn config_serialization_roundtrip() {
        let cfg = GctlConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let parsed: GctlConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.otel.listen_port, cfg.otel.listen_port);
    }

    #[test]
    fn sync_config_defaults_to_disabled() {
        let cfg = SyncConfig::default();
        assert!(!cfg.enabled);
        assert!(cfg.r2_bucket.is_empty());
    }
}
