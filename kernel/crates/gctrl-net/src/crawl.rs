//! BFS web crawler with depth/page limits. Saves pages as markdown via SiteStore.

use crate::{CrawlResult, NetError, PageContent};
use crate::storage::SiteStore;
use reqwest::Client;
use scraper::{Html, Selector};
use std::collections::HashSet;
use url::Url;

/// Configuration for a crawl operation.
#[derive(Debug, Clone)]
pub struct CrawlConfig {
    /// Maximum crawl depth from the start URL.
    pub max_depth: usize,
    /// Maximum pages to crawl.
    pub max_pages: usize,
    /// Delay between requests in milliseconds.
    pub delay_ms: u64,
    /// Use readability extraction.
    pub readability: bool,
    /// Minimum word count to keep a page.
    pub min_words: usize,
    /// URL patterns to skip (substring match).
    pub skip_patterns: Vec<String>,
}

impl Default for CrawlConfig {
    fn default() -> Self {
        Self {
            max_depth: 3,
            max_pages: 50,
            delay_ms: 200,
            readability: true,
            min_words: 50,
            skip_patterns: default_skip_patterns(),
        }
    }
}

fn default_skip_patterns() -> Vec<String> {
    [
        "/admin", "/login", "/signup", "/auth",
        "/api/", "/cdn-cgi/", "/static/",
        ".pdf", ".zip", ".tar", ".gz",
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
        ".css", ".js", ".woff", ".woff2",
        "?utm_", "#", "mailto:",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Crawl a website starting from `start_url`, saving pages to `store`.
pub async fn crawl_site(
    start_url: &str,
    config: &CrawlConfig,
    store: &SiteStore,
) -> Result<CrawlResult, NetError> {
    let base = Url::parse(start_url)?;
    let domain = base.host_str().unwrap_or("unknown").to_string();

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; gctrl-net/0.1; +https://github.com/debuggingfuture/gctrl)")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: Vec<(String, usize)> = vec![(normalize_url(&base), 0)];
    let mut pages_crawled = 0;
    let mut pages_skipped = 0;
    let mut total_words = 0;

    while let Some((url, depth)) = queue.pop() {
        if pages_crawled >= config.max_pages {
            break;
        }
        if depth > config.max_depth {
            continue;
        }
        if visited.contains(&url) {
            continue;
        }
        if should_skip(&url, &config.skip_patterns) {
            pages_skipped += 1;
            visited.insert(url);
            continue;
        }

        visited.insert(url.clone());

        match fetch_and_extract(&client, &url, &domain, config).await {
            Ok((page, links)) => {
                total_words += page.word_count;
                pages_crawled += 1;

                store.save_page(&domain, &page)?;

                tracing::info!(
                    url = %page.url,
                    words = page.word_count,
                    links = links.len(),
                    depth,
                    "crawled page"
                );

                for link in links {
                    if !visited.contains(&link) {
                        queue.push((link, depth + 1));
                    }
                }
            }
            Err(e) => {
                tracing::warn!(url, error = %e, "failed to fetch page");
                pages_skipped += 1;
            }
        }

        if config.delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(config.delay_ms)).await;
        }
    }

    Ok(CrawlResult {
        domain,
        pages_crawled,
        pages_skipped,
        total_words,
    })
}

/// Fetch a URL, convert to markdown, and extract same-domain links from raw HTML.
async fn fetch_and_extract(
    client: &Client,
    url: &str,
    domain: &str,
    config: &CrawlConfig,
) -> Result<(PageContent, Vec<String>), NetError> {
    let parsed = Url::parse(url)?;
    let resp = client.get(url).send().await?;
    let status = resp.status().as_u16();
    let html = resp.text().await?;

    // Extract links from raw HTML before converting
    let links = extract_links_from_html(&html, &parsed, domain);

    // Convert HTML to markdown
    let (title, markdown) = crate::fetch::html_to_markdown(&html, url, config.readability);
    let word_count = markdown.split_whitespace().count();

    if word_count < config.min_words {
        return Err(NetError::BelowThreshold {
            url: url.to_string(),
            word_count,
            min_words: config.min_words,
        });
    }

    let page = PageContent {
        url: url.to_string(),
        title,
        markdown,
        word_count,
        status,
    };

    Ok((page, links))
}

/// Extract same-domain links from raw HTML.
pub fn extract_links_from_html(html: &str, base_url: &Url, domain: &str) -> Vec<String> {
    let doc = Html::parse_document(html);
    let selector = Selector::parse("a[href]").unwrap();
    let mut links = Vec::new();

    for el in doc.select(&selector) {
        if let Some(href) = el.attr("href") {
            if let Ok(resolved) = base_url.join(href) {
                if resolved.host_str() == Some(domain) && resolved.scheme().starts_with("http") {
                    let normalized = normalize_url(&resolved);
                    links.push(normalized);
                }
            }
        }
    }

    links.sort();
    links.dedup();
    links
}

fn normalize_url(url: &Url) -> String {
    let mut s = url.as_str().to_string();
    // Strip fragment
    if let Some(pos) = s.find('#') {
        s.truncate(pos);
    }
    // Strip trailing slash for consistency
    if s.ends_with('/') && s.len() > url.scheme().len() + 3 {
        s.pop();
    }
    s
}

fn should_skip(url: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| url.contains(p.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_url() {
        let url = Url::parse("https://example.com/docs/").unwrap();
        assert_eq!(normalize_url(&url), "https://example.com/docs");
    }

    #[test]
    fn test_normalize_url_strips_fragment() {
        let url = Url::parse("https://example.com/docs#section").unwrap();
        assert_eq!(normalize_url(&url), "https://example.com/docs");
    }

    #[test]
    fn test_should_skip() {
        let patterns = default_skip_patterns();
        assert!(should_skip("https://example.com/admin/panel", &patterns));
        assert!(should_skip("https://example.com/file.pdf", &patterns));
        assert!(!should_skip("https://example.com/docs/guide", &patterns));
    }

    #[test]
    fn test_extract_links_from_html() {
        let html = r#"
            <html><body>
                <a href="/docs/guide">Guide</a>
                <a href="https://example.com/docs/api">API</a>
                <a href="https://other.com/nope">External</a>
                <a href="/login">Login</a>
            </body></html>
        "#;
        let base = Url::parse("https://example.com/docs/").unwrap();
        let links = extract_links_from_html(html, &base, "example.com");
        assert!(links.contains(&"https://example.com/docs/guide".to_string()));
        assert!(links.contains(&"https://example.com/docs/api".to_string()));
        assert!(links.contains(&"https://example.com/login".to_string()));
        assert!(!links.iter().any(|l| l.contains("other.com")));
    }

    #[test]
    fn test_crawl_config_default() {
        let cfg = CrawlConfig::default();
        assert_eq!(cfg.max_depth, 3);
        assert_eq!(cfg.max_pages, 50);
        assert!(cfg.readability);
    }
}
