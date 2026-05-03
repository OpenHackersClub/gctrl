//! Chromium process launcher.
//!
//! Behind a trait so tests can inject a `MockLauncher` that points at a
//! local echo WebSocket instead of spawning a real browser. CI runners
//! without Chromium / display server use the mock; the real launcher is
//! exercised by `#[ignore]`d smoke tests and the `gctrld` daemon at
//! runtime.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::error::BrowserError;

/// A running Chromium process exposing a CDP WebSocket. The proxy connects
/// outbound to `browser_ws_url` and relays frames to/from clients.
pub struct LaunchedChromium {
    /// Stable identifier for the underlying Chromium process. Used by the
    /// pool to attribute sessions to a Chromium and by recycle accounting.
    pub id: String,
    /// `ws://127.0.0.1:<port>/devtools/browser/<browser-uuid>` returned
    /// from the Chromium debug server's `/json/version`.
    pub browser_ws_url: String,
    /// User-agent style version string (e.g. `Chrome/124.0.6367.78`).
    pub version: String,
    /// Process handle. Behind a `Mutex` so the pool can call `kill().await`
    /// without taking ownership; `MockLauncher` returns `None` since there
    /// is nothing to kill.
    pub child: Arc<Mutex<Option<Child>>>,
}

#[async_trait]
pub trait Launcher: Send + Sync {
    async fn launch(&self) -> Result<LaunchedChromium, BrowserError>;
}

/// Spawns a real Chromium process with a random debug port, then resolves
/// the browser-level CDP WebSocket URL by polling
/// `http://127.0.0.1:<port>/json/version`.
pub struct RealLauncher {
    chromium_path: PathBuf,
    headed: bool,
    user_data_root: PathBuf,
}

impl RealLauncher {
    pub fn new(chromium_path: Option<PathBuf>, headed: bool) -> Result<Self, BrowserError> {
        let path = match chromium_path {
            Some(p) => p,
            None => autodetect_chromium()?,
        };
        // Each launcher gets its own user-data root so multiple Chromiums
        // in the pool don't fight over `SingletonLock`. Keyed by daemon
        // PID so concurrent gctrld instances during tests don't collide.
        let user_data_root =
            std::env::temp_dir().join(format!("gctrl-browser-{}", std::process::id()));
        std::fs::create_dir_all(&user_data_root)
            .map_err(|e| BrowserError::Launch(format!("create user-data dir: {e}")))?;
        Ok(Self {
            chromium_path: path,
            headed,
            user_data_root,
        })
    }
}

#[async_trait]
impl Launcher for RealLauncher {
    async fn launch(&self) -> Result<LaunchedChromium, BrowserError> {
        let id = uuid::Uuid::new_v4().to_string();
        let user_dir = self.user_data_root.join(&id);

        let mut cmd = Command::new(&self.chromium_path);
        cmd.arg("--remote-debugging-port=0")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-networking")
            .arg("--disable-default-apps")
            .arg("--disable-popup-blocking")
            .arg("--disable-sync")
            .arg("--disable-renderer-backgrounding")
            .arg("--disable-backgrounding-occluded-windows")
            .arg("--disable-background-timer-throttling")
            .arg("--password-store=basic")
            .arg("--use-mock-keychain")
            .arg(format!("--user-data-dir={}", user_dir.display()));

        if !self.headed {
            cmd.arg("--headless=new");
        }

        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| BrowserError::Launch(format!("spawn chromium: {e}")))?;

        // Chromium writes the debug port to <user-data-dir>/DevToolsActivePort
        // shortly after the listener is up. First line is the port; second
        // line is the browser path. Polling avoids racing on stderr parsing.
        let port_file = user_dir.join("DevToolsActivePort");
        let port = wait_for_port(&port_file, Duration::from_secs(15)).await?;

        let (ws_url, version) = fetch_version(port).await?;

        Ok(LaunchedChromium {
            id,
            browser_ws_url: ws_url,
            version,
            child: Arc::new(Mutex::new(Some(child))),
        })
    }
}

fn autodetect_chromium() -> Result<PathBuf, BrowserError> {
    #[cfg(target_os = "macos")]
    {
        for p in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            if std::path::Path::new(p).exists() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    for name in [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
    ] {
        if let Ok(p) = which::which(name) {
            return Ok(p);
        }
    }
    Err(BrowserError::Launch(
        "could not locate a Chromium binary; set GCTRL_BROWSER_CHROMIUM_PATH".into(),
    ))
}

async fn wait_for_port(path: &std::path::Path, deadline: Duration) -> Result<u16, BrowserError> {
    let start = std::time::Instant::now();
    loop {
        if let Ok(contents) = tokio::fs::read_to_string(path).await {
            if let Some(first) = contents.lines().next() {
                if let Ok(port) = first.trim().parse::<u16>() {
                    return Ok(port);
                }
            }
        }
        if start.elapsed() >= deadline {
            return Err(BrowserError::Launch(format!(
                "DevToolsActivePort did not appear within {}s",
                deadline.as_secs()
            )));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[derive(Debug, Deserialize)]
struct VersionInfo {
    #[serde(rename = "Browser")]
    browser: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws_url: String,
}

async fn fetch_version(port: u16) -> Result<(String, String), BrowserError> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| BrowserError::Launch(format!("build http client: {e}")))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| BrowserError::Launch(format!("get /json/version: {e}")))?;
    let info: VersionInfo = resp
        .json()
        .await
        .map_err(|e| BrowserError::Launch(format!("parse /json/version: {e}")))?;
    Ok((info.ws_url, info.browser))
}

/// Mock launcher used by route + pool tests. Each `launch()` returns a
/// fixed `browser_ws_url` provided up-front. The proxy will connect to it
/// like any other CDP endpoint.
pub struct MockLauncher {
    pub ws_url: String,
    pub version: String,
}

impl MockLauncher {
    pub fn new(ws_url: impl Into<String>) -> Self {
        Self {
            ws_url: ws_url.into(),
            version: "Chromium/mock".into(),
        }
    }
}

#[async_trait]
impl Launcher for MockLauncher {
    async fn launch(&self) -> Result<LaunchedChromium, BrowserError> {
        Ok(LaunchedChromium {
            id: uuid::Uuid::new_v4().to_string(),
            browser_ws_url: self.ws_url.clone(),
            version: self.version.clone(),
            child: Arc::new(Mutex::new(None)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_launcher_returns_configured_url() {
        let l = MockLauncher::new("ws://127.0.0.1:0/fake");
        let c = l.launch().await.unwrap();
        assert_eq!(c.browser_ws_url, "ws://127.0.0.1:0/fake");
        assert_eq!(c.version, "Chromium/mock");
        assert!(!c.id.is_empty());
    }
}
