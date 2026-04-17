//! Single-page fetch with HTML→markdown conversion and readability extraction.

use crate::{NetError, PageContent};
use reqwest::Client;
use url::Url;

/// Options for fetching a single page.
#[derive(Debug, Clone)]
pub struct FetchOptions {
    /// Use readability extraction to strip boilerplate (nav, footer, ads).
    pub readability: bool,
    /// Minimum word count to accept the page.
    pub min_words: usize,
    /// Custom User-Agent string.
    pub user_agent: String,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            readability: true,
            min_words: 50,
            user_agent: "Mozilla/5.0 (compatible; gctrl-net/0.1; +https://github.com/debuggingfuture/gctrl)".into(),
        }
    }
}

/// Fetch a single URL and convert to agent-optimized markdown.
pub async fn fetch_page(url_str: &str, opts: &FetchOptions) -> Result<PageContent, NetError> {
    let url = Url::parse(url_str)?;
    let client = Client::builder()
        .user_agent(&opts.user_agent)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let resp = client.get(url.as_str()).send().await?;
    let status = resp.status().as_u16();
    let html = resp.text().await?;

    let (title, markdown) = html_to_markdown(&html, url.as_str(), opts.readability);

    let word_count = markdown.split_whitespace().count();

    if word_count < opts.min_words {
        return Err(NetError::BelowThreshold {
            url: url_str.to_string(),
            word_count,
            min_words: opts.min_words,
        });
    }

    Ok(PageContent {
        url: url_str.to_string(),
        title,
        markdown,
        word_count,
        status,
    })
}

/// Convert HTML to markdown, optionally using readability extraction first.
pub(crate) fn html_to_markdown(html: &str, url: &str, use_readability: bool) -> (String, String) {
    if use_readability {
        if let Some((title, content)) = extract_readable(html, url) {
            let md = htmd::convert(&content).unwrap_or_default();
            let full_md = htmd::convert(html).unwrap_or_default();

            // If readability output is less than 25% of full content, fall back
            if !md.is_empty() && (full_md.is_empty() || md.len() * 4 >= full_md.len()) {
                return (title, clean_markdown(&md));
            }
        }
    }

    let title = extract_title(html);
    let md = htmd::convert(html).unwrap_or_default();
    (title, clean_markdown(&md))
}

/// Use readability to extract article content from HTML.
fn extract_readable(html: &str, url: &str) -> Option<(String, String)> {
    use readability::extractor;
    use std::io::Cursor;

    let mut cursor = Cursor::new(html.as_bytes());
    match extractor::extract(&mut cursor, &Url::parse(url).ok()?) {
        Ok(product) => Some((product.title, product.content)),
        Err(_) => None,
    }
}

/// Extract <title> from HTML as fallback.
fn extract_title(html: &str) -> String {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    let sel = Selector::parse("title").unwrap();
    doc.select(&sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default()
}

/// Clean up converted markdown: collapse blank lines, trim whitespace.
fn clean_markdown(md: &str) -> String {
    let mut result = String::with_capacity(md.len());
    let mut blank_count = 0;

    for line in md.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_count += 1;
            if blank_count <= 1 {
                result.push('\n');
            }
        } else {
            blank_count = 0;
            result.push_str(trimmed);
            result.push('\n');
        }
    }

    result.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_title() {
        let html = "<html><head><title>My Page</title></head><body>hello</body></html>";
        assert_eq!(extract_title(html), "My Page");
    }

    #[test]
    fn test_extract_title_missing() {
        let html = "<html><body>no title</body></html>";
        assert_eq!(extract_title(html), "");
    }

    #[test]
    fn test_html_to_markdown_basic() {
        let html = "<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>";
        let (title, md) = html_to_markdown(html, "https://example.com", false);
        assert_eq!(title, "Test");
        assert!(md.contains("Hello"));
        assert!(md.contains("World"));
    }

    #[test]
    fn test_clean_markdown_collapses_blanks() {
        let input = "line1\n\n\n\n\nline2\n\n\nline3";
        let result = clean_markdown(input);
        assert!(!result.contains("\n\n\n"));
    }

    #[test]
    fn test_fetch_options_default() {
        let opts = FetchOptions::default();
        assert!(opts.readability);
        assert_eq!(opts.min_words, 50);
    }
}
