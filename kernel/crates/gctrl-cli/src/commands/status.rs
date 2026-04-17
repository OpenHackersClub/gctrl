use anyhow::Result;
use gctrl_core::GctlConfig;

pub fn run() -> Result<()> {
    let config = GctlConfig::default();
    println!("=== GroundCtrl Status ===");
    println!("Version:     {}", env!("CARGO_PKG_VERSION"));
    println!("DB path:     {}", config.storage.db_path.display());
    println!("OTel port:   {}", config.otel.listen_port);
    println!("Proxy port:  {}", config.proxy.listen_port);
    println!("R2 sync:     {}", if config.sync.enabled { "enabled" } else { "disabled" });
    println!("Raw SQL:     {}", if config.guardrails.allow_raw_sql { "allowed" } else { "blocked" });
    println!("Config file: {}", GctlConfig::config_path().display());
    Ok(())
}
