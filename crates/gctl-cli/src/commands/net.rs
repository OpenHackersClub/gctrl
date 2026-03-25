//! `gctl net` commands — web scraping and agent-optimized context generation.

use anyhow::Result;
use gctl_net::{
    compact_site, crawl_site, fetch_page,
    CompactFormat, CompactOptions, CrawlConfig, FetchOptions, SiteStore,
};

/// Fetch a single URL and print markdown to stdout.
pub async fn fetch(url: &str, no_readability: bool, min_words: usize) -> Result<()> {
    let opts = FetchOptions {
        readability: !no_readability,
        min_words,
        ..Default::default()
    };

    let page = fetch_page(url, &opts).await?;

    eprintln!(
        "Fetched {} — {} words, status {}",
        page.url, page.word_count, page.status
    );

    println!("{}", page.markdown);
    Ok(())
}

/// Crawl a website and save pages as markdown.
pub async fn crawl(
    url: &str,
    depth: usize,
    max_pages: usize,
    delay_ms: u64,
    no_readability: bool,
    min_words: usize,
) -> Result<()> {
    let config = CrawlConfig {
        max_depth: depth,
        max_pages,
        delay_ms,
        readability: !no_readability,
        min_words,
        ..Default::default()
    };

    let store = SiteStore::default_store()?;
    let result = crawl_site(url, &config, &store).await?;

    println!("Crawl complete: {}", result.domain);
    println!(
        "  Pages crawled: {} | Skipped: {} | Total words: {}",
        result.pages_crawled, result.pages_skipped, result.total_words
    );
    println!(
        "  Stored in: {}",
        store.domain_dir(&result.domain).display()
    );

    Ok(())
}

/// List all crawled domains.
pub fn list() -> Result<()> {
    let store = SiteStore::default_store()?;
    let domains = store.list_domains()?;

    if domains.is_empty() {
        println!("No crawled sites. Use `gctl net crawl <url>` to get started.");
        return Ok(());
    }

    println!("{:<40} {:>6} {:>8}", "DOMAIN", "PAGES", "WORDS");
    println!("{}", "-".repeat(56));

    for domain in &domains {
        if let Some(index) = store.load_index(domain) {
            println!(
                "{:<40} {:>6} {:>8}",
                domain,
                index.pages.len(),
                index.total_words
            );
        }
    }

    Ok(())
}

/// Show crawled content for a domain.
pub fn show(domain: &str, page: Option<&str>) -> Result<()> {
    let store = SiteStore::default_store()?;

    if let Some(file) = page {
        let content = store.read_page(domain, file)?;
        println!("{}", content);
    } else {
        let index = store
            .load_index(domain)
            .ok_or_else(|| anyhow::anyhow!("domain not found: {}", domain))?;

        println!("{} — {} pages, {} words", domain, index.pages.len(), index.total_words);
        println!("Last crawl: {}", index.last_crawl);
        println!();
        println!("{:<50} {:>6}", "FILE", "WORDS");
        println!("{}", "-".repeat(58));
        for entry in &index.pages {
            println!("{:<50} {:>6}", entry.file, entry.word_count);
        }
    }

    Ok(())
}

/// Show crawl statistics for a domain.
pub fn stats(domain: &str) -> Result<()> {
    let store = SiteStore::default_store()?;
    let index = store
        .load_index(domain)
        .ok_or_else(|| anyhow::anyhow!("domain not found: {}", domain))?;

    let page_count = index.pages.len();
    let total_words = index.total_words;
    let avg_words = if page_count > 0 { total_words / page_count } else { 0 };
    let max_words = index.pages.iter().map(|p| p.word_count).max().unwrap_or(0);
    let min_words = index.pages.iter().map(|p| p.word_count).min().unwrap_or(0);

    println!("Domain: {}", domain);
    println!("Last crawl: {}", index.last_crawl);
    println!();
    println!("  Pages:       {}", page_count);
    println!("  Total words: {}", total_words);
    println!("  Avg words:   {}", avg_words);
    println!("  Min words:   {}", min_words);
    println!("  Max words:   {}", max_words);
    println!();

    // Top 5 pages by word count
    let mut pages = index.pages.clone();
    pages.sort_by(|a, b| b.word_count.cmp(&a.word_count));
    println!("Top pages by word count:");
    println!("{:<50} {:>6}", "FILE", "WORDS");
    println!("{}", "-".repeat(58));
    for entry in pages.iter().take(5) {
        println!("{:<50} {:>6}", entry.file, entry.word_count);
    }

    Ok(())
}

/// Compact all pages into a single agent-optimized context file.
pub fn compact(domain: &str, format: &str, output: Option<&str>) -> Result<()> {
    let store = SiteStore::default_store()?;
    let fmt = match format {
        "index" => CompactFormat::Index,
        _ => CompactFormat::Gitingest,
    };

    let opts = CompactOptions {
        format: fmt,
        output_dir: output.map(std::path::PathBuf::from),
    };

    let result = compact_site(domain, &store, &opts)?;

    if let Some(out_dir) = &opts.output_dir {
        let filename = match fmt {
            CompactFormat::Gitingest => format!("{}_CONTEXT.md", domain.replace('.', "_").to_uppercase()),
            CompactFormat::Index => format!("{}_CONTEXT_INDEX.md", domain.replace('.', "_").to_uppercase()),
        };
        let path = std::path::Path::new(out_dir).join(&filename);
        std::fs::create_dir_all(out_dir)?;
        std::fs::write(&path, &result)?;
        eprintln!("Written to: {}", path.display());
    } else {
        println!("{}", result);
    }

    Ok(())
}
