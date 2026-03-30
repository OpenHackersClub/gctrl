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
}

impl Default for GctlConfig {
    fn default() -> Self {
        Self {
            storage: StorageConfig::default(),
            otel: OtelConfig::default(),
            proxy: ProxyConfig::default(),
            sync: SyncConfig::default(),
            guardrails: GuardrailsConfig::default(),
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
        let data_dir = dirs_default_data().join("gctl");
        Self {
            db_path: data_dir.join("gctl.duckdb"),
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
    pub r2_bucket: String,
    pub r2_endpoint: String,
    pub interval_seconds: u64,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            r2_bucket: String::new(),
            r2_endpoint: String::new(),
            interval_seconds: 300,
        }
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
            PathBuf::from(home).join(".config/gctl/config.toml")
        } else {
            PathBuf::from("/tmp/gctl/config.toml")
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
