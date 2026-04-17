//! Filesystem storage for crawled pages. One directory per domain, one .md per page.
//!
//! Layout:
//!   {data_dir}/spider/{domain}/
//!     _index.json     — site manifest (pages, last crawl time)
//!     getting-started.md
//!     api/overview.md

use crate::{NetError, PageContent};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use url::Url;

/// Manages crawled page storage on the filesystem.
#[derive(Debug, Clone)]
pub struct SiteStore {
    base_dir: PathBuf,
}

/// Entry in the site index manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageEntry {
    pub url: String,
    pub file: String,
    pub title: String,
    pub word_count: usize,
}

/// Site manifest stored as _index.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteIndex {
    pub domain: String,
    pub pages: Vec<PageEntry>,
    pub last_crawl: String,
    pub total_words: usize,
}

impl SiteStore {
    /// Create a store at the default data directory.
    pub fn default_store() -> Result<Self, NetError> {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("gctrl")
            .join("spider");
        Ok(Self { base_dir: base })
    }

    /// Create a store at a custom path.
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Root directory for a domain's crawled content.
    pub fn domain_dir(&self, domain: &str) -> PathBuf {
        self.base_dir.join(domain)
    }

    /// Save a crawled page to the filesystem.
    pub fn save_page(&self, domain: &str, page: &PageContent) -> Result<(), NetError> {
        let dir = self.domain_dir(domain);
        let rel_path = url_to_filename(&page.url);
        let file_path = dir.join(&rel_path);

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Write markdown with frontmatter
        let content = format!(
            "---\nurl: {}\ntitle: {}\nwords: {}\n---\n\n# {}\n\n{}",
            page.url, page.title, page.word_count, page.title, page.markdown
        );
        std::fs::write(&file_path, &content)?;

        // Update index
        self.update_index(domain, page, &rel_path)?;

        Ok(())
    }

    /// Update the _index.json manifest for a domain.
    fn update_index(&self, domain: &str, page: &PageContent, rel_path: &str) -> Result<(), NetError> {
        let index_path = self.domain_dir(domain).join("_index.json");
        let mut index = self.load_index(domain).unwrap_or_else(|| SiteIndex {
            domain: domain.to_string(),
            pages: Vec::new(),
            last_crawl: chrono::Utc::now().to_rfc3339(),
            total_words: 0,
        });

        // Remove existing entry for this URL
        index.pages.retain(|p| p.url != page.url);

        index.pages.push(PageEntry {
            url: page.url.clone(),
            file: rel_path.to_string(),
            title: page.title.clone(),
            word_count: page.word_count,
        });

        index.total_words = index.pages.iter().map(|p| p.word_count).sum();
        index.last_crawl = chrono::Utc::now().to_rfc3339();

        let json = serde_json::to_string_pretty(&index)?;
        std::fs::write(&index_path, json)?;

        Ok(())
    }

    /// Load the site index for a domain.
    pub fn load_index(&self, domain: &str) -> Option<SiteIndex> {
        let index_path = self.domain_dir(domain).join("_index.json");
        let content = std::fs::read_to_string(&index_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// List all crawled domains.
    pub fn list_domains(&self) -> Result<Vec<String>, NetError> {
        let mut domains = Vec::new();
        if !self.base_dir.exists() {
            return Ok(domains);
        }
        for entry in std::fs::read_dir(&self.base_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    if self.domain_dir(name).join("_index.json").exists() {
                        domains.push(name.to_string());
                    }
                }
            }
        }
        domains.sort();
        Ok(domains)
    }

    /// Read a specific page's markdown content.
    pub fn read_page(&self, domain: &str, file: &str) -> Result<String, NetError> {
        let path = self.domain_dir(domain).join(file);
        Ok(std::fs::read_to_string(&path)?)
    }

    /// Read all pages for a domain, sorted by URL depth then alphabetically.
    pub fn read_all_pages(&self, domain: &str) -> Result<Vec<(PageEntry, String)>, NetError> {
        let index = self
            .load_index(domain)
            .ok_or_else(|| NetError::DomainNotFound(domain.to_string()))?;

        let mut pages: Vec<(PageEntry, String)> = Vec::new();
        for entry in &index.pages {
            match self.read_page(domain, &entry.file) {
                Ok(content) => pages.push((entry.clone(), content)),
                Err(e) => tracing::warn!(file = %entry.file, error = %e, "skipped unreadable page"),
            }
        }

        // Sort by URL depth (fewer slashes first), then alphabetically
        pages.sort_by(|(a, _), (b, _)| {
            let depth_a = a.url.matches('/').count();
            let depth_b = b.url.matches('/').count();
            depth_a.cmp(&depth_b).then(a.url.cmp(&b.url))
        });

        Ok(pages)
    }
}

/// Convert a URL to a filesystem-safe relative path ending in .md.
fn url_to_filename(url_str: &str) -> String {
    let url = match Url::parse(url_str) {
        Ok(u) => u,
        Err(_) => return "index.md".to_string(),
    };

    let path = url.path().trim_matches('/');
    if path.is_empty() {
        return "index.md".to_string();
    }

    // Replace URL path segments with filesystem path
    let clean = path
        .replace('/', std::path::MAIN_SEPARATOR_STR)
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != std::path::MAIN_SEPARATOR, "-");

    if clean.ends_with(".md") {
        clean
    } else {
        format!("{}.md", clean)
    }
}

impl From<serde_json::Error> for NetError {
    fn from(e: serde_json::Error) -> Self {
        NetError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_url_to_filename() {
        assert_eq!(url_to_filename("https://example.com/"), "index.md");
        assert_eq!(url_to_filename("https://example.com/docs/guide"), "docs/guide.md");
        assert_eq!(url_to_filename("https://example.com/api/v2/users"), "api/v2/users.md");
    }

    #[test]
    fn test_store_save_and_read() {
        let tmp = TempDir::new().unwrap();
        let store = SiteStore::new(tmp.path().to_path_buf());

        let page = PageContent {
            url: "https://example.com/docs/guide".to_string(),
            title: "Getting Started".to_string(),
            markdown: "This is the guide content with enough words to pass any threshold check.".to_string(),
            word_count: 14,
            status: 200,
        };

        store.save_page("example.com", &page).unwrap();

        let index = store.load_index("example.com").unwrap();
        assert_eq!(index.pages.len(), 1);
        assert_eq!(index.pages[0].title, "Getting Started");
        assert_eq!(index.total_words, 14);

        let content = store.read_page("example.com", "docs/guide.md").unwrap();
        assert!(content.contains("Getting Started"));
    }

    #[test]
    fn test_list_domains() {
        let tmp = TempDir::new().unwrap();
        let store = SiteStore::new(tmp.path().to_path_buf());

        let page = PageContent {
            url: "https://example.com/".to_string(),
            title: "Example".to_string(),
            markdown: "hello world content here for testing purposes with many words".to_string(),
            word_count: 10,
            status: 200,
        };
        store.save_page("example.com", &page).unwrap();
        store.save_page("docs.other.com", &page).unwrap();

        let domains = store.list_domains().unwrap();
        assert_eq!(domains.len(), 2);
        assert!(domains.contains(&"docs.other.com".to_string()));
        assert!(domains.contains(&"example.com".to_string()));
    }
}
