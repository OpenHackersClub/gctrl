//! Brave Search API client.
//!
//! Docs: <https://brave.com/search/api/> — endpoints `/res/v1/{web,news,images}/search`.
//! Auth: `X-Subscription-Token` header.

use crate::NetError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const BRAVE_BASE: &str = "https://api.search.brave.com/res/v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchKind {
    Web,
    News,
    Images,
}

impl SearchKind {
    fn path(self) -> &'static str {
        match self {
            SearchKind::Web => "web/search",
            SearchKind::News => "news/search",
            SearchKind::Images => "images/search",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub freshness: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub kind: String,
    pub results: Vec<SearchResult>,
}

pub struct BraveSearchClient {
    client: Client,
    api_key: String,
}

impl BraveSearchClient {
    pub fn new(api_key: String) -> Result<Self, NetError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { client, api_key })
    }

    /// Reuse an existing `reqwest::Client` (preferred when the caller already
    /// maintains a long-lived client — saves per-request connection pool setup).
    pub fn with_client(client: Client, api_key: String) -> Self {
        Self { client, api_key }
    }

    pub async fn search(&self, kind: SearchKind, query: &SearchQuery) -> Result<SearchResponse, NetError> {
        let url = format!("{}/{}", BRAVE_BASE, kind.path());

        let mut req = self
            .client
            .get(&url)
            .header("Accept", "application/json")
            .header("X-Subscription-Token", &self.api_key)
            .query(&[("q", query.q.as_str())]);

        if let Some(c) = query.count {
            req = req.query(&[("count", c.to_string())]);
        }
        if let Some(ref country) = query.country {
            req = req.query(&[("country", country.as_str())]);
        }
        if let Some(ref f) = query.freshness {
            req = req.query(&[("freshness", f.as_str())]);
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;

        if status >= 400 {
            return Err(NetError::BackendError {
                provider: "brave-search",
                status,
                body: text,
            });
        }

        let parsed: serde_json::Value = serde_json::from_str(&text)?;
        let results = match kind {
            SearchKind::Web => extract_web(&parsed),
            SearchKind::News => extract_news(&parsed),
            SearchKind::Images => extract_images(&parsed),
        };

        Ok(SearchResponse {
            query: query.q.clone(),
            kind: format!("{:?}", kind).to_lowercase(),
            results,
        })
    }
}

fn extract_web(v: &serde_json::Value) -> Vec<SearchResult> {
    v.pointer("/web/results")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().map(row_to_result).collect())
        .unwrap_or_default()
}

fn extract_news(v: &serde_json::Value) -> Vec<SearchResult> {
    v.pointer("/results")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().map(row_to_result).collect())
        .unwrap_or_default()
}

fn extract_images(v: &serde_json::Value) -> Vec<SearchResult> {
    v.pointer("/results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .map(|row| SearchResult {
                    title: row.get("title").and_then(|s| s.as_str()).unwrap_or("").into(),
                    url: row.get("url").and_then(|s| s.as_str()).unwrap_or("").into(),
                    description: row
                        .pointer("/thumbnail/src")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .into(),
                    age: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn row_to_result(row: &serde_json::Value) -> SearchResult {
    SearchResult {
        title: row.get("title").and_then(|s| s.as_str()).unwrap_or("").into(),
        url: row.get("url").and_then(|s| s.as_str()).unwrap_or("").into(),
        description: row
            .get("description")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .into(),
        age: row.get("age").and_then(|s| s.as_str()).map(String::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_kind_paths() {
        assert_eq!(SearchKind::Web.path(), "web/search");
        assert_eq!(SearchKind::News.path(), "news/search");
        assert_eq!(SearchKind::Images.path(), "images/search");
    }

    #[test]
    fn extract_web_parses_brave_shape() {
        let body = serde_json::json!({
            "web": {
                "results": [
                    { "title": "T", "url": "https://a", "description": "D", "age": "1d" },
                    { "title": "T2", "url": "https://b", "description": "D2" }
                ]
            }
        });
        let out = extract_web(&body);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "T");
        assert_eq!(out[0].age.as_deref(), Some("1d"));
        assert!(out[1].age.is_none());
    }

    #[test]
    fn extract_web_missing_gracefully() {
        let body = serde_json::json!({});
        assert!(extract_web(&body).is_empty());
    }

    #[test]
    fn client_builds_with_key() {
        let _ = BraveSearchClient::new("k".into()).unwrap();
    }
}
