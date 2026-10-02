//! Chromium process launcher.
//!
//! Behind a trait so tests can inject a `MockLauncher` that points at a
//! local echo WebSocket instead of spawning a real browser. CI runners
//! without Chromium / display server use the mock; the real launcher is
//! exercised by `#[ignore]`d smoke tests and the `gctrld` daemon at
//! runtime.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::error::BrowserError;

pub use gctrl_core::browser::{LaunchedChromium, Launcher};

/// Spawns a real Chromium process with a random debug port, then resolves
/// the browser-level CDP WebSocket URL by polling
/// `http://127.0.0.1:<port>/json/version`.
pub struct RealLauncher {
    chromium_path: PathBuf,
    headed: bool,
    user_data_root: PathBuf,
    children: Mutex<std::collections::HashMap<String, Child>>,
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
            children: Mutex::new(std::collections::HashMap::new()),
        })
    }
}

#[async_trait]
impl Launcher for RealLauncher {
    async fn kill(&self, process_id: &str) -> Result<(), BrowserError> {
        let mut children = self.children.lock().await;
        if let Some(child) = children.get_mut(process_id) {
            tokio::time::timeout(Duration::from_secs(15), child.kill())
                .await
                .map_err(|_| BrowserError::Launch("process exit confirmation timed out".into()))?
                .map_err(|e| BrowserError::Launch(format!("confirm process exit: {e}")))?;
            children.remove(process_id);
        }
        Ok(())
    }
    async fn create_context(&self, chromium: &LaunchedChromium) -> Result<String, BrowserError> {
        let result = control_command(
            &chromium.browser_ws_url,
            "Target.createBrowserContext",
            serde_json::json!({}),
        )
        .await?;
        result["browserContextId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                BrowserError::Cdp("createBrowserContext returned no context identity".into())
            })
    }

    async fn dispose_context(&self, endpoint: &str, context_id: &str) -> Result<(), BrowserError> {
        control_command(
            endpoint,
            "Target.disposeBrowserContext",
            serde_json::json!({"browserContextId":context_id}),
        )
        .await?;
        Ok(())
    }

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

        self.children.lock().await.insert(id.clone(), child);
        Ok(LaunchedChromium {
            id,
            browser_ws_url: ws_url,
            version,
        })
    }
}

async fn control_command(
    endpoint: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, BrowserError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    tokio::time::timeout(Duration::from_secs(10), async {
        let (mut ws, _) = tokio_tungstenite::connect_async(endpoint)
            .await
            .map_err(|e| BrowserError::Cdp(format!("context control connect: {e}")))?;
        ws.send(Message::Text(
            serde_json::json!({"id":1,"method":method,"params":params}).to_string(),
        ))
        .await
        .map_err(|e| BrowserError::Cdp(format!("context control send: {e}")))?;
        while let Some(frame) = ws.next().await {
            let frame =
                frame.map_err(|e| BrowserError::Cdp(format!("context control receive: {e}")))?;
            if let Message::Text(text) = frame {
                let reply: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| BrowserError::Cdp(format!("context control JSON: {e}")))?;
                if reply["id"] == 1 {
                    if let Some(error) = reply.get("error") {
                        return Err(BrowserError::Cdp(format!("{method}: {error}")));
                    }
                    return Ok(reply["result"].clone());
                }
            }
        }
        Err(BrowserError::Cdp(format!(
            "context control closed during {method}"
        )))
    })
    .await
    .map_err(|_| BrowserError::Cdp(format!("context control timeout during {method}")))?
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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| BrowserError::Launch(format!("build http client: {e}")))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        // DevToolsActivePort may precede a ready HTTP listener. Probe the same
        // process; never spawn a replacement in response to a startup race.
        let result = async {
            let response = client
                .get(format!("http://127.0.0.1:{port}/json/version"))
                .send()
                .await
                .map_err(|e| BrowserError::Launch(format!("get /json/version: {e}")))?
                .error_for_status()
                .map_err(|e| BrowserError::Launch(format!("/json/version status: {e}")))?;
            let info: VersionInfo = response
                .json()
                .await
                .map_err(|e| BrowserError::Launch(format!("parse /json/version: {e}")))?;
            Ok((info.ws_url, info.browser))
        }
        .await;
        match result {
            Ok(info) => return Ok(info),
            Err(error) if tokio::time::Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
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
    async fn kill(&self, _: &str) -> Result<(), BrowserError> {
        Ok(())
    }
    async fn create_context(&self, _chromium: &LaunchedChromium) -> Result<String, BrowserError> {
        Ok(format!("mock-context-{}", uuid::Uuid::new_v4()))
    }
    async fn dispose_context(
        &self,
        _endpoint: &str,
        _context_id: &str,
    ) -> Result<(), BrowserError> {
        Ok(())
    }

    async fn launch(&self) -> Result<LaunchedChromium, BrowserError> {
        Ok(LaunchedChromium {
            id: uuid::Uuid::new_v4().to_string(),
            browser_ws_url: self.ws_url.clone(),
            version: self.version.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn mock_launcher_returns_configured_url() {
        let l = MockLauncher::new("ws://127.0.0.1:0/fake");
        let c = l.launch().await.unwrap();
        assert_eq!(c.browser_ws_url, "ws://127.0.0.1:0/fake");
        assert_eq!(c.version, "Chromium/mock");
        assert!(!c.id.is_empty());
    }
    #[tokio::test]
    async fn chromium_version_probe_waits_for_the_listener_to_be_ready() {
        use axum::{routing::get, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = attempts.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/json/version", get(move || {
            let seen = seen.clone();
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({"error":"starting"})))
                } else {
                    (axum::http::StatusCode::OK, axum::Json(serde_json::json!({"Browser":"Chromium/test","webSocketDebuggerUrl":"ws://owned"})))
                }
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = fetch_version(port).await;
        server.abort();
        assert_eq!(
            result.unwrap(),
            ("ws://owned".into(), "Chromium/test".into())
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
