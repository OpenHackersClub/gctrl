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

    /// Raw `/screenshot` endpoint — returns a PNG as base64.
    pub async fn screenshot(&self, url: &str) -> Result<String, NetError> {
        let body = serde_json::json!({ "url": url });
        let result = self.post_json("screenshot", body).await?;
        // Result is base64 string when `screenshotOptions` not set, or object with data.
        match result {
            serde_json::Value::String(s) => Ok(s),
            serde_json::Value::Object(ref m) => m
                .get("screenshot")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| NetError::BackendError {
                    provider: "cloudflare-browser",
                    status: 0,
                    body: "screenshot key missing from result".into(),
                }),
            _ => Err(NetError::BackendError {
                provider: "cloudflare-browser",
                status: 0,
                body: "unexpected screenshot response shape".into(),
            }),
        }
    }

    /// `/scrape` endpoint — structured scrape by CSS selectors.
    pub async fn scrape(
        &self,
        url: &str,
        elements: Vec<ScrapeElement>,
    ) -> Result<serde_json::Value, NetError> {
        let body = serde_json::json!({
            "url": url,
            "elements": elements,
        });
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
