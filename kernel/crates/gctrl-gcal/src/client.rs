use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Mutex;

use crate::error::GcalError;
use crate::model::{Calendar, CalendarEvent, CalendarList, EventInput, EventList};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API_BASE: &str = "https://www.googleapis.com/calendar/v3";

/// OAuth credentials. The refresh token is long-lived; access tokens are
/// minted on demand and held in memory only.
#[derive(Debug, Clone)]
pub struct GcalCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    /// Optional override for the token endpoint — useful for tests against a
    /// mock OAuth server.
    pub token_url: Option<String>,
    /// Optional override for the API base URL — useful for tests.
    pub api_base: Option<String>,
}

impl GcalCredentials {
    /// Read credentials from `GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`,
    /// `GCAL_REFRESH_TOKEN`. Returns `Ok(None)` if any is missing — the
    /// driver is meant to advertise itself as offline rather than crashing
    /// the daemon.
    pub fn from_env() -> Result<Option<Self>, GcalError> {
        let client_id = std::env::var("GCAL_CLIENT_ID").ok();
        let client_secret = std::env::var("GCAL_CLIENT_SECRET").ok();
        let refresh_token = std::env::var("GCAL_REFRESH_TOKEN").ok();
        match (client_id, client_secret, refresh_token) {
            (Some(id), Some(secret), Some(token))
                if !id.is_empty() && !secret.is_empty() && !token.is_empty() =>
            {
                Ok(Some(Self {
                    client_id: id,
                    client_secret: secret,
                    refresh_token: token,
                    token_url: None,
                    api_base: None,
                }))
            }
            _ => Ok(None),
        }
    }
}

#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_expires")]
    expires_in: u64,
}

fn default_expires() -> u64 {
    3600
}

#[derive(Clone)]
pub struct GcalClient {
    http: reqwest::Client,
    creds: GcalCredentials,
    token: Arc<Mutex<Option<CachedToken>>>,
}

impl GcalClient {
    pub fn new(http: reqwest::Client, creds: GcalCredentials) -> Self {
        Self {
            http,
            creds,
            token: Arc::new(Mutex::new(None)),
        }
    }

    fn api_base(&self) -> &str {
        self.creds.api_base.as_deref().unwrap_or(API_BASE)
    }

    fn token_url(&self) -> &str {
        self.creds.token_url.as_deref().unwrap_or(TOKEN_URL)
    }

    /// Returns a valid access token, refreshing if the cached value is missing
    /// or within 60s of expiry.
    async fn access_token(&self) -> Result<String, GcalError> {
        let mut guard = self.token.lock().await;
        if let Some(cached) = guard.as_ref() {
            if cached.expires_at.saturating_duration_since(Instant::now()) > Duration::from_secs(60)
            {
                return Ok(cached.access_token.clone());
            }
        }

        let params = [
            ("client_id", self.creds.client_id.as_str()),
            ("client_secret", self.creds.client_secret.as_str()),
            ("refresh_token", self.creds.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ];
        let resp = self
            .http
            .post(self.token_url())
            .form(&params)
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(GcalError::OauthRefresh(format!(
                "{} {}",
                status.as_u16(),
                body
            )));
        }
        let parsed: TokenResponse = serde_json::from_str(&body)
            .map_err(|e| GcalError::Parse(format!("token response: {e}")))?;
        let cached = CachedToken {
            access_token: parsed.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(parsed.expires_in),
        };
        *guard = Some(cached);
        Ok(parsed.access_token)
    }

    async fn authed(&self, builder: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder, GcalError> {
        let token = self.access_token().await?;
        Ok(builder.bearer_auth(token))
    }

    async fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        builder: reqwest::RequestBuilder,
    ) -> Result<T, GcalError> {
        let resp = self.authed(builder).await?.send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(GcalError::Api {
                status: status.as_u16(),
                body,
            });
        }
        serde_json::from_str::<T>(&body).map_err(|e| GcalError::Parse(e.to_string()))
    }

    pub async fn list_calendars(&self) -> Result<Vec<Calendar>, GcalError> {
        let url = format!("{}/users/me/calendarList", self.api_base());
        let parsed: CalendarList = self.send_json(self.http.get(&url)).await?;
        Ok(parsed.items)
    }

    pub async fn list_events(
        &self,
        calendar_id: &str,
        time_min: Option<&str>,
        time_max: Option<&str>,
        max_results: Option<u32>,
    ) -> Result<Vec<CalendarEvent>, GcalError> {
        let url = format!(
            "{}/calendars/{}/events",
            self.api_base(),
            urlencoding(calendar_id)
        );
        let mut req = self.http.get(&url).query(&[
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ]);
        if let Some(t) = time_min {
            req = req.query(&[("timeMin", t)]);
        }
        if let Some(t) = time_max {
            req = req.query(&[("timeMax", t)]);
        }
        if let Some(n) = max_results {
            req = req.query(&[("maxResults", n.to_string())]);
        }
        let parsed: EventList = self.send_json(req).await?;
        Ok(parsed.items)
    }

    pub async fn get_event(
        &self,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<CalendarEvent, GcalError> {
        let url = format!(
            "{}/calendars/{}/events/{}",
            self.api_base(),
            urlencoding(calendar_id),
            urlencoding(event_id)
        );
        self.send_json(self.http.get(&url)).await
    }

    pub async fn create_event(
        &self,
        calendar_id: &str,
        input: &EventInput,
    ) -> Result<CalendarEvent, GcalError> {
        let url = format!(
            "{}/calendars/{}/events",
            self.api_base(),
            urlencoding(calendar_id)
        );
        self.send_json(self.http.post(&url).json(input)).await
    }

    pub async fn patch_event(
        &self,
        calendar_id: &str,
        event_id: &str,
        input: &EventInput,
    ) -> Result<CalendarEvent, GcalError> {
        let url = format!(
            "{}/calendars/{}/events/{}",
            self.api_base(),
            urlencoding(calendar_id),
            urlencoding(event_id)
        );
        self.send_json(self.http.patch(&url).json(input)).await
    }
}

/// Minimal percent-encoding for path segments (calendar id can contain `@`).
fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_env_returns_none_when_missing() {
        // Snapshot + clear potentially-set vars; restore at end.
        let prev_id = std::env::var("GCAL_CLIENT_ID").ok();
        let prev_secret = std::env::var("GCAL_CLIENT_SECRET").ok();
        let prev_token = std::env::var("GCAL_REFRESH_TOKEN").ok();
        std::env::remove_var("GCAL_CLIENT_ID");
        std::env::remove_var("GCAL_CLIENT_SECRET");
        std::env::remove_var("GCAL_REFRESH_TOKEN");

        let result = GcalCredentials::from_env().unwrap();
        assert!(result.is_none());

        if let Some(v) = prev_id {
            std::env::set_var("GCAL_CLIENT_ID", v);
        }
        if let Some(v) = prev_secret {
            std::env::set_var("GCAL_CLIENT_SECRET", v);
        }
        if let Some(v) = prev_token {
            std::env::set_var("GCAL_REFRESH_TOKEN", v);
        }
    }
}
