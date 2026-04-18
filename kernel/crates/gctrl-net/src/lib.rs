//! Network tools: web fetching, crawling, readability extraction, and agent-optimized context.
//!
//! Converts web content to markdown optimized for LLM context windows.
//! Supports single-page fetch, multi-page crawl, and gitingest-style compaction.

mod fetch;
mod crawl;
mod compact;
mod storage;
mod error;
pub mod render;
pub mod search;

pub use fetch::{fetch_page, FetchOptions};
pub use crawl::{crawl_site, CrawlConfig};
pub use compact::{compact_site, CompactOptions, CompactFormat};
pub use storage::{SiteStore, PageEntry};
pub use error::NetError;
pub use render::{CfBrowserBackend, RenderBackend, RenderMode, RenderedHtml, ScrapeElement, StaticBackend};
pub use search::{BraveSearchClient, SearchKind, SearchQuery, SearchResponse, SearchResult};

/// Result of fetching or crawling a single page.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PageContent {
    pub url: String,
    pub title: String,
    pub markdown: String,
    pub word_count: usize,
    pub status: u16,
}

/// Summary of a crawl operation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CrawlResult {
    pub domain: String,
    pub pages_crawled: usize,
    pub pages_skipped: usize,
    pub total_words: usize,
}
