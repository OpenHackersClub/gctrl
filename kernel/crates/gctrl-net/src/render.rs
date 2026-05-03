//! Render backends for fetching HTML. Chooses between a plain `reqwest` call and
//! Cloudflare Browser Rendering (headless Chromium) per request.

use crate::NetError;
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// How to fetch a page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RenderMode {
    /// Plain HTTP GET via reqwest (fast, no JS).
    #[default]
    Static,
    /// Cloudflare Browser Rendering (headless Chromium, runs JS).
    Browser {
        /// CSS selector to wait for before returning HTML.
        #[serde(default)]
        wait_for: Option<String>,
    },
    /// Local kernel `driver-browser`. Acquires a session from the
    /// running gctrld at `kernel_base_url` and drives it over CDP to
    /// produce post-JS HTML. Use for SPA scraping when CF Browser
    /// Rendering quotas are inconvenient. Requires `gctrld` reachable
    /// on the loopback (default `http://127.0.0.1:4318`).
    Kernel {
        #[serde(default)]
        wait_for: Option<String>,
        #[serde(default)]
        kernel_base_url: Option<String>,
    },
}

/// HTML + status returned from any render backend.
#[derive(Debug, Clone)]
pub struct RenderedHtml {
    pub url: String,
    pub status: u16,
    pub html: String,
}

#[async_trait]
pub trait RenderBackend: Send + Sync {
    async fn render(&self, url: &str) -> Result<RenderedHtml, NetError>;
}

/// Static backend — reqwest GET, returns raw HTML.
pub struct StaticBackend {
    client: Client,
}

impl StaticBackend {
    pub fn new(user_agent: &str) -> Result<Self, NetError> {
        let client = Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self { client })
    }
}

#[async_trait]
impl RenderBackend for StaticBackend {
    async fn render(&self, url: &str) -> Result<RenderedHtml, NetError> {
        let resp = self.client.get(url).send().await?;
        let status = resp.status().as_u16();
        let html = resp.text().await?;
        Ok(RenderedHtml { url: url.to_string(), status, html })
    }
}

/// Cloudflare Browser Rendering backend — headless Chromium via REST API.
///
/// API: `POST https://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/content`
/// Docs: <https://developers.cloudflare.com/browser-rendering/rest-api/>
pub struct CfBrowserBackend {
    client: Client,
    account_id: String,
    api_token: String,
    wait_for: Option<String>,
}

impl CfBrowserBackend {
    pub fn new(account_id: String, api_token: String, wait_for: Option<String>) -> Result<Self, NetError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self { client, account_id, api_token, wait_for })
    }

    /// Reuse an existing `reqwest::Client` so handler calls don't rebuild the
    /// connection pool per request.
    pub fn with_client(
        client: Client,
        account_id: String,
        api_token: String,
        wait_for: Option<String>,
    ) -> Self {
        Self { client, account_id, api_token, wait_for }
    }

    fn endpoint(&self, op: &str) -> String {
        format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/browser-rendering/{}",
            self.account_id, op
        )
    }

    /// POST to a browser-rendering endpoint, return parsed JSON envelope's `result`.
    pub(crate) async fn post_json(
        &self,
        op: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, NetError> {
        let resp = self
            .client
            .post(self.endpoint(op))
            .bearer_auth(&self.api_token)
            .json(&body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let text = resp.text().await?;

        if status >= 400 {
            return Err(NetError::BackendError {
                provider: "cloudflare-browser",
                status,
                body: text,
            });
        }

        let envelope: CfEnvelope = serde_json::from_str(&text)?;
        if !envelope.success {
            return Err(NetError::BackendError {
                provider: "cloudflare-browser",
                status,
                body: envelope
                    .errors
                    .and_then(|e| serde_json::to_string(&e).ok())
                    .unwrap_or_else(|| text.clone()),
            });
        }
        Ok(envelope.result.unwrap_or(serde_json::Value::Null))
    }

    /// `/screenshot` endpoint. CF returns raw `image/png` bytes by default,
    /// and only switches to the JSON envelope when
    /// `screenshotOptions.encoding = "base64"` is set. We handle both shapes:
    /// inspect `Content-Type` and either base64-encode the body ourselves or
    /// parse the envelope.
    pub async fn screenshot(&self, url: &str) -> Result<String, NetError> {
        use base64::Engine;

        let body = serde_json::json!({ "url": url });
        let resp = self
            .client
            .post(self.endpoint("screenshot"))
            .bearer_auth(&self.api_token)
            .json(&body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if status >= 400 {
            let text = resp.text().await.unwrap_or_default();
            return Err(NetError::BackendError { provider: "cloudflare-browser", status, body: text });
        }

        if content_type.starts_with("application/json") {
            let text = resp.text().await?;
            let envelope: CfEnvelope = serde_json::from_str(&text)?;
            if !envelope.success {
                return Err(NetError::BackendError {
                    provider: "cloudflare-browser",
                    status,
                    body: envelope
                        .errors
                        .and_then(|e| serde_json::to_string(&e).ok())
                        .unwrap_or(text),
                });
            }
            return match envelope.result {
                Some(serde_json::Value::String(s)) => Ok(s),
                Some(serde_json::Value::Object(ref m)) => m
                    .get("screenshot")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .ok_or_else(|| NetError::BackendError {
                        provider: "cloudflare-browser",
                        status,
                        body: "screenshot key missing from JSON result".into(),
                    }),
                other => Err(NetError::BackendError {
                    provider: "cloudflare-browser",
                    status,
                    body: format!("unexpected screenshot JSON shape: {other:?}"),
                }),
            };
        }

        // Raw image body — base64-encode it for JSON transport.
        let bytes = resp.bytes().await?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    }

    /// `/scrape` endpoint — structured scrape by CSS selectors.
    /// `wait_for` forwards a CSS selector to wait for before scraping.
    pub async fn scrape(
        &self,
        url: &str,
        elements: Vec<ScrapeElement>,
        wait_for: Option<String>,
    ) -> Result<serde_json::Value, NetError> {
        let mut body = serde_json::json!({
            "url": url,
            "elements": elements,
        });
        if let Some(sel) = wait_for {
            body["waitForSelector"] = serde_json::Value::String(sel);
        }
        self.post_json("scrape", body).await
    }
}

#[async_trait]
impl RenderBackend for CfBrowserBackend {
    async fn render(&self, url: &str) -> Result<RenderedHtml, NetError> {
        let mut body = serde_json::json!({ "url": url });
        if let Some(sel) = &self.wait_for {
            body["waitForSelector"] = serde_json::Value::String(sel.clone());
        }
        let result = self.post_json("content", body).await?;
        let html = result
            .as_str()
            .map(|s| s.to_string())
            .or_else(|| result.get("html").and_then(|v| v.as_str()).map(String::from))
            .ok_or_else(|| NetError::BackendError {
                provider: "cloudflare-browser",
                status: 0,
                body: "content key missing from result".into(),
            })?;
        Ok(RenderedHtml { url: url.to_string(), status: 200, html })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScrapeElement {
    pub selector: String,
}

/// Render via the local kernel `driver-browser`. Acquires a session,
/// drives `Page.navigate` over CDP, waits for `Page.frameStoppedLoading`
/// (and optionally a CSS selector), reads `document.documentElement.outerHTML`
/// via `Runtime.evaluate`, then releases the session.
///
/// Hard requirement: `gctrld` is reachable on `base_url` and the
/// driver-browser pool can launch Chromium. If acquire fails (e.g. no
/// Chromium on PATH), the error surfaces as `BackendError`.
pub struct KernelBrowserBackend {
    base_url: String,
    wait_for: Option<String>,
    http: Client,
}

impl KernelBrowserBackend {
    pub fn new(base_url: impl Into<String>, wait_for: Option<String>) -> Result<Self, NetError> {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            base_url: base_url.into(),
            wait_for,
            http,
        })
    }
}

#[derive(Debug, Deserialize)]
struct KernelSessionInfo {
    id: String,
    #[serde(rename = "cdpEndpoint")]
    cdp_endpoint: String,
    #[allow(dead_code)]
    token: String,
}

#[async_trait]
impl RenderBackend for KernelBrowserBackend {
    async fn render(&self, url: &str) -> Result<RenderedHtml, NetError> {
        let session = acquire_kernel_session(&self.http, &self.base_url).await?;
        let html_result = drive_cdp(&session.cdp_endpoint, url, self.wait_for.as_deref()).await;
        // Always best-effort release; ignore errors.
        let _ = self
            .http
            .delete(format!(
                "{}/api/browser/sessions/{}",
                self.base_url, session.id
            ))
            .send()
            .await;
        let html = html_result?;
        Ok(RenderedHtml {
            url: url.to_string(),
            status: 200,
            html,
        })
    }
}

async fn acquire_kernel_session(
    http: &Client,
    base_url: &str,
) -> Result<KernelSessionInfo, NetError> {
    let resp = http
        .post(format!("{}/api/browser/sessions", base_url))
        .json(&serde_json::json!({ "ttlSeconds": 120 }))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(NetError::BackendError {
            provider: "kernel-browser",
            status: status.as_u16(),
            body,
        });
    }
    Ok(resp.json().await?)
}

async fn drive_cdp(
    ws_url: &str,
    target_url: &str,
    wait_for_selector: Option<&str>,
) -> Result<String, NetError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| NetError::BackendError {
            provider: "kernel-browser",
            status: 0,
            body: format!("connect cdp: {e}"),
        })?;

    // Use a shared id counter; each command picks a fresh id.
    let mut id: u64 = 0;
    let mut send = |method: &str, params: serde_json::Value| {
        id += 1;
        let frame = serde_json::json!({ "id": id, "method": method, "params": params });
        (id, Message::Text(frame.to_string().into()))
    };

    let (page_enable_id, msg) = send("Page.enable", serde_json::json!({}));
    ws.send(msg).await.map_err(cdp_err)?;
    let _ = wait_for_response(&mut ws, page_enable_id).await?;

    let (nav_id, msg) = send(
        "Page.navigate",
        serde_json::json!({ "url": target_url }),
    );
    ws.send(msg).await.map_err(cdp_err)?;
    let _ = wait_for_response(&mut ws, nav_id).await?;

    // Wait for load. CDP fires `Page.loadEventFired` when the document's
    // load event completes. Tolerate up to 30s.
    wait_for_event(&mut ws, "Page.loadEventFired", std::time::Duration::from_secs(30)).await?;

    if let Some(sel) = wait_for_selector {
        // Best-effort selector wait: poll up to 10s via Runtime.evaluate.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (eid, msg) = send(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": format!("!!document.querySelector({:?})", sel),
                    "returnByValue": true,
                }),
            );
            ws.send(msg).await.map_err(cdp_err)?;
            let resp = wait_for_response(&mut ws, eid).await?;
            let found = resp
                .pointer("/result/result/value")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if found || std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    let (eid, msg) = send(
        "Runtime.evaluate",
        serde_json::json!({
            "expression": "document.documentElement.outerHTML",
            "returnByValue": true,
        }),
    );
    ws.send(msg).await.map_err(cdp_err)?;
    let resp = wait_for_response(&mut ws, eid).await?;
    let html = resp
        .pointer("/result/result/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| NetError::BackendError {
            provider: "kernel-browser",
            status: 0,
            body: "Runtime.evaluate did not return outerHTML".into(),
        })?
        .to_string();

    let _ = ws.close(None).await;
    let _ = ws.next().await;
    Ok(html)
}

async fn wait_for_response<S>(ws: &mut S, id: u64) -> Result<serde_json::Value, NetError>
where
    S: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        let frame = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            ws.next(),
        )
        .await
        .map_err(|_| NetError::BackendError {
            provider: "kernel-browser",
            status: 0,
            body: "cdp response timeout".into(),
        })?;
        let Some(msg) = frame else {
            return Err(NetError::BackendError {
                provider: "kernel-browser",
                status: 0,
                body: "cdp socket closed".into(),
            });
        };
        let msg = msg.map_err(cdp_err)?;
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t)
                .map_err(|e| NetError::BackendError {
                    provider: "kernel-browser",
                    status: 0,
                    body: format!("cdp non-json frame: {e}"),
                })?;
            if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                return Ok(v);
            }
        }
    }
    Err(NetError::BackendError {
        provider: "kernel-browser",
        status: 0,
        body: format!("cdp response for id={id} not received"),
    })
}

async fn wait_for_event<S>(
    ws: &mut S,
    method: &str,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, NetError>
where
    S: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let frame = match tokio::time::timeout(remaining, ws.next()).await {
            Ok(f) => f,
            Err(_) => break,
        };
        let Some(msg) = frame else { break };
        let msg = msg.map_err(cdp_err)?;
        if let Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                if v.get("method").and_then(|m| m.as_str()) == Some(method) {
                    return Ok(v);
                }
            }
        }
    }
    Err(NetError::BackendError {
        provider: "kernel-browser",
        status: 0,
        body: format!("event {method} not seen within timeout"),
    })
}

fn cdp_err(e: tokio_tungstenite::tungstenite::Error) -> NetError {
    NetError::BackendError {
        provider: "kernel-browser",
        status: 0,
        body: format!("cdp ws: {e}"),
    }
}

#[derive(Debug, Deserialize)]
struct CfEnvelope {
    success: bool,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    errors: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_mode_static_default() {
        let m = RenderMode::default();
        assert!(matches!(m, RenderMode::Static));
    }

    #[test]
    fn render_mode_serde_browser() {
        let m = RenderMode::Browser { wait_for: Some("#app".into()) };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"kind\":\"browser\""));
        let back: RenderMode = serde_json::from_str(&json).unwrap();
        match back {
            RenderMode::Browser { wait_for } => assert_eq!(wait_for.as_deref(), Some("#app")),
            _ => panic!("expected browser"),
        }
    }

    #[test]
    fn cf_backend_endpoint_format() {
        let be = CfBrowserBackend::new("abc123".into(), "tok".into(), None).unwrap();
        assert_eq!(
            be.endpoint("content"),
            "https://api.cloudflare.com/client/v4/accounts/abc123/browser-rendering/content"
        );
    }

    #[tokio::test]
    async fn static_backend_builds() {
        let be = StaticBackend::new("gctrl-test").unwrap();
        // Just verify it constructs; network call happens in integration tests.
        let _ = be;
    }
}
