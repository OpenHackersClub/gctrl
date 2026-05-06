use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use gctrl_core::{NetConfig, ProxyConfig, SchedulerConfig, SyncConfig};
use gctrl_proxy::{Capture, CaptureConfig, LlmRelay, RelayConfig};
use gctrl_scheduler::ScheduleRunner;
use gctrl_storage::{DuckDbStore, SqliteStore};

use super::host_allowlist_middleware;
use super::watch;

/// Read scheduler config from env. Operators opt into exec target by setting:
///
///   GCTRL_SCHEDULER_EXEC_ENABLED=1
///   GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS=/abs/path/to/node:/abs/path/to/uv
///
/// Both default to off-and-empty. Config-file parsing is a separate work item.
fn scheduler_config_from_env() -> SchedulerConfig {
    let mut cfg = SchedulerConfig::default();
    if let Ok(v) = std::env::var("GCTRL_SCHEDULER_EXEC_ENABLED") {
        cfg.exec_enabled = matches!(v.as_str(), "1" | "true" | "yes" | "on");
    }
    if let Ok(v) = std::env::var("GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS") {
        cfg.exec_allowed_programs = v
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
    }
    cfg
}

/// Options for the gctrl-proxy LLM relay. `None` disables the relay.
#[derive(Debug, Clone)]
pub struct RelayOpts {
    pub port: u16,
    pub upstream: String,
}

pub async fn run(
    host: String,
    port: u16,
    db_path: &str,
    board_dir: Option<PathBuf>,
    proxy_enabled: bool,
    relay: Option<RelayOpts>,
) -> Result<()> {
    let store = Arc::new(DuckDbStore::open(db_path)?);

    // SQLite for board/inbox/persona — co-located with DuckDB
    let sqlite_path = if db_path == ":memory:" {
        ":memory:".to_string()
    } else {
        db_path.replace(".duckdb", ".sqlite")
    };
    let sqlite = Arc::new(SqliteStore::open(&sqlite_path)?);
    tracing::info!("sqlite (board/inbox): {sqlite_path}");

    // Spawn one file watcher per row in `gctrl_vault_mounts`. Each watcher
    // writes to SQLite (the source of truth for board data, and the origin
    // side of the SQLite → D1 sync). The legacy single `board_dir` arg is
    // kept only so the kernel router can serve `/api/sync/vault/*` against
    // the same root the operator configured on the CLI; mounts are now the
    // exclusive source for *which* directories get watched.
    let vault_root = board_dir.clone();

    // Bootstrap a `default` mount when the operator passed a vault root and
    // the mounts table is empty. Without this the desktop sidecar — which has
    // no UI to register a mount yet — silently idles its watcher and the
    // board surface stays empty even when `<vault>/BOARD/*.md` exists on
    // disk. CLI users who already curate mounts via `/api/vault/mounts` are
    // unaffected (the empty-table guard skips the bootstrap).
    if let Some(ref root) = vault_root {
        bootstrap_default_vault_mount(&sqlite, root);
    }

    let watcher_store = Arc::clone(&sqlite);
    tokio::spawn(watch::watch_all_vault_mounts(watcher_store));

    let sync_config = SyncConfig::from_env();
    let sync_config = if sync_config.d1_enabled() {
        tracing::info!("D1 sync enabled: database_id={}", sync_config.d1_database_id);
        Some(Arc::new(sync_config))
    } else {
        None
    };

    let net_config = NetConfig::from_env();
    if net_config.brave_api_key.is_some() {
        tracing::info!("Brave Search enabled");
    }
    if net_config.cf_browser_enabled() {
        tracing::info!("Cloudflare Browser Rendering enabled");
    }

    // Spawn the scheduler runner. Defaults: 30s poll, 16 jobs/tick, 60s
    // timeout, exec disabled. Operators opt into exec by setting env
    // variables — config-file parsing is a separate work item.
    let scheduler_config = scheduler_config_from_env();
    if scheduler_config.exec_enabled {
        if scheduler_config.exec_allowed_programs.is_empty() {
            tracing::warn!(
                "scheduler.exec_enabled=true but exec_allowed_programs is empty — exec rows will be refused at fire-time"
            );
        } else {
            tracing::info!(
                "scheduler exec target enabled with {} allowed program(s)",
                scheduler_config.exec_allowed_programs.len()
            );
        }
    }
    let scheduler_config_arc = Arc::new(scheduler_config.clone());
    if scheduler_config.enabled {
        // Plant `_internal.scheduler_runs_gc` if missing / replace if
        // corrupt. This keeps `scheduler_runs` retention working without
        // operator action; the GC routine fires the prune route via the
        // same scheduler that owns it. Failure is non-fatal — the daemon
        // can still serve everything else; retention just stops accruing.
        if let Err(e) =
            gctrl_scheduler::ensure_gc_schedule(&sqlite, &scheduler_config)
        {
            tracing::warn!(
                error = %e,
                "scheduler: failed to bootstrap _internal.scheduler_runs_gc — retention pruning will not run"
            );
        }
        let runner_store = Arc::clone(&sqlite);
        let runner_cfg = scheduler_config.clone();
        tokio::spawn(async move {
            ScheduleRunner::new(runner_store, runner_cfg).run_forever().await;
        });
        tracing::info!("scheduler runner spawned (poll={}s)", scheduler_config.poll_interval_secs);
    }

    // Spawn the LLM relay (gctrl-proxy LlmRelay) on its own port. It points
    // its OTLP emitter at this same daemon's receiver, so opencode (or any
    // OpenAI-compat client) → relay → upstream LLM, with spans + prompt
    // bodies landing in the same DuckDB.
    if let Some(opts) = relay {
        let relay_addr = format!("{host}:{}", opts.port);
        let kernel_otlp_url = format!("http://{host}:{port}/v1/traces");
        let capture = Arc::new(Capture::new(
            Arc::clone(&store),
            CaptureConfig {
                kernel_otlp_url,
                default_service_name: "llm-client".to_string(),
            },
        ));
        let relay_cfg = RelayConfig {
            upstream_url: opts.upstream.clone(),
            session_header: "x-session-id".to_string(),
            service_header: "x-service-name".to_string(),
        };
        let relay_router = LlmRelay::new(relay_cfg, capture).router();
        tracing::info!(
            "gctrl LLM relay listening on {relay_addr} → {}",
            opts.upstream
        );
        tokio::spawn(async move {
            match tokio::net::TcpListener::bind(&relay_addr).await {
                Ok(listener) => {
                    if let Err(e) = axum::serve(listener, relay_router).await {
                        tracing::error!(error = %e, "LLM relay serve loop ended");
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, addr = %relay_addr, "LLM relay bind failed");
                }
            }
        });
    } else {
        tracing::info!("LLM relay disabled (--no-relay)");
    }

    let router = gctrl_otel::create_router_full_with_vault(
        Arc::clone(&store),
        Arc::clone(&sqlite),
        sync_config,
        Arc::new(net_config),
        Arc::clone(&scheduler_config_arc),
        vault_root,
        None, // honor GCTRL_STATE_DIR or platform default
    );
    let router = host_allowlist_middleware::apply(router);
    let addr = format!("{host}:{port}");
    tracing::info!("gctrl OTel receiver listening on {addr}");
    tracing::info!("database: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let axum_fut = axum::serve(listener, router);

    // Spawn the MITM proxy alongside the receiver if enabled. Both share the
    // same DuckDbStore so traffic rows go through the kernel's single-writer
    // lock — no parallel data path.
    if proxy_enabled {
        let mut proxy_config = ProxyConfig::default();
        if let Ok(p) = std::env::var("GCTRL_PROXY_PORT") {
            if let Ok(p) = p.parse::<u16>() {
                proxy_config.listen_port = p;
            }
        }
        let proxy_store = Arc::clone(&store);
        let proxy_cfg = proxy_config.clone();
        tokio::spawn(async move {
            if let Err(e) = gctrl_proxy::run(proxy_store, proxy_cfg).await {
                tracing::error!(error = %e, "proxy exited with error");
            }
        });
        tracing::info!(
            "MITM proxy enabled on {}:{}",
            proxy_config.listen_host,
            proxy_config.listen_port
        );
    }

    axum_fut.await?;
    Ok(())
}

/// Insert a `default` Workspace mount pointing at `root` if and only if
/// `gctrl_vault_mounts` is empty. Idempotent across daemon restarts: once
/// the mount exists (or any other mount has been registered) this is a
/// no-op and the operator's curated mounts win. Failure is non-fatal —
/// the daemon still serves everything else; the file watcher just stays
/// idle until a mount is registered manually.
fn bootstrap_default_vault_mount(sqlite: &SqliteStore, root: &std::path::Path) {
    let mounts = match sqlite.list_vault_mounts() {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "vault bootstrap: failed to list mounts");
            return;
        }
    };
    if !mounts.is_empty() {
        return;
    }
    let now = chrono::Utc::now();
    let mount = gctrl_core::VaultMount {
        id: uuid::Uuid::new_v4().to_string(),
        name: "default".into(),
        root_path: root.to_string_lossy().into_owned(),
        kind: gctrl_core::VaultMountKind::Workspace,
        git_url: None,
        app_id: None,
        last_commit_sha: None,
        last_synced_at: None,
        created_at: now,
        updated_at: now,
    };
    match sqlite.create_vault_mount(&mount) {
        Ok(()) => tracing::info!(
            path = %root.display(),
            "vault bootstrap: registered `default` mount"
        ),
        Err(e) => tracing::warn!(
            path = %root.display(),
            error = %e,
            "vault bootstrap: create_vault_mount failed"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_creates_default_mount_when_table_empty() {
        let sqlite = SqliteStore::open(":memory:").unwrap();
        let tmp = tempfile::TempDir::new().unwrap();

        bootstrap_default_vault_mount(&sqlite, tmp.path());

        let mounts = sqlite.list_vault_mounts().unwrap();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].name, "default");
        assert_eq!(mounts[0].root_path, tmp.path().to_string_lossy());
        assert_eq!(mounts[0].kind, gctrl_core::VaultMountKind::Workspace);
    }

    #[test]
    fn bootstrap_is_noop_when_any_mount_already_exists() {
        let sqlite = SqliteStore::open(":memory:").unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        let now = chrono::Utc::now();
        sqlite
            .create_vault_mount(&gctrl_core::VaultMount {
                id: "preexisting".into(),
                name: "curated".into(),
                root_path: "/elsewhere".into(),
                kind: gctrl_core::VaultMountKind::App,
                git_url: None,
                app_id: None,
                last_commit_sha: None,
                last_synced_at: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();

        bootstrap_default_vault_mount(&sqlite, tmp.path());

        let mounts = sqlite.list_vault_mounts().unwrap();
        assert_eq!(mounts.len(), 1, "operator's curated mount must be preserved");
        assert_eq!(mounts[0].name, "curated");
    }
}
