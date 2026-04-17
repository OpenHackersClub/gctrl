//! `gctrl context` commands — manage agent context (docs, configs, snapshots).

use anyhow::Result;
use gctrl_context::ContextManager;
use gctrl_core::context::*;

fn open_manager(db_path: &str) -> Result<ContextManager> {
    Ok(ContextManager::open(db_path, None)?)
}

/// Add a local file as a context entry.
pub fn add(
    file: &str,
    path: Option<&str>,
    kind: &str,
    tags: Option<&str>,
    db_path: &str,
) -> Result<()> {
    let content = std::fs::read_to_string(file)?;
    let mgr = open_manager(db_path)?;

    let kind = ContextKind::from_str(kind)
        .ok_or_else(|| anyhow::anyhow!("invalid kind: {} (use: config, snapshot, document)", kind))?;

    // Default path is the filename
    let rel_path = path.unwrap_or_else(|| {
        std::path::Path::new(file)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(file)
    });

    let title = rel_path
        .trim_end_matches(".md")
        .replace('/', " — ")
        .replace('-', " ")
        .replace('_', " ");

    let tags: Vec<String> = tags
        .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let entry = mgr.upsert(&kind, rel_path, &title, &content, &ContextSource::Human, &tags)?;

    println!("Added context entry:");
    println!("  ID:    {}", entry.id.0);
    println!("  Path:  {}/{}", entry.kind.as_str(), entry.path);
    println!("  Title: {}", entry.title);
    println!("  Words: {}", entry.word_count);
    println!("  Hash:  {}…", &entry.content_hash[..12]);

    Ok(())
}

/// List context entries with optional filters.
pub fn list(
    kind: Option<&str>,
    tag: Option<&str>,
    search: Option<&str>,
    format: &str,
    db_path: &str,
) -> Result<()> {
    let mgr = open_manager(db_path)?;

    let filter = ContextFilter {
        kind: kind.and_then(ContextKind::from_str),
        tag: tag.map(String::from),
        search: search.map(String::from),
        ..Default::default()
    };

    let entries = mgr.list(&filter)?;

    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }

    if entries.is_empty() {
        println!("No context entries. Use `gctrl context add <file>` to get started.");
        return Ok(());
    }

    println!(
        "{:<36} {:<10} {:<30} {:>6} {:<10}",
        "ID", "KIND", "PATH", "WORDS", "SOURCE"
    );
    println!("{}", "-".repeat(94));

    for entry in &entries {
        println!(
            "{:<36} {:<10} {:<30} {:>6} {:<10}",
            entry.id.0,
            entry.kind.as_str(),
            truncate(&entry.path, 30),
            entry.word_count,
            entry.source.source_type(),
        );
    }

    println!("\n{} entries", entries.len());
    Ok(())
}

/// Show a context entry's content.
pub fn show(entry_ref: &str, db_path: &str) -> Result<()> {
    let mgr = open_manager(db_path)?;

    // Try by ID first, then by path
    let content = mgr
        .read_content(entry_ref)
        .or_else(|_| mgr.read_content_by_path(entry_ref))?;

    println!("{}", content);
    Ok(())
}

/// Remove a context entry.
pub fn remove(entry_ref: &str, db_path: &str) -> Result<()> {
    let mgr = open_manager(db_path)?;

    // Try by ID first, then by path
    let result = mgr.remove(entry_ref).or_else(|_| mgr.remove_by_path(entry_ref));

    match result {
        Ok(()) => println!("Removed: {}", entry_ref),
        Err(e) => return Err(anyhow::anyhow!("not found: {} ({})", entry_ref, e)),
    }

    Ok(())
}

/// Compact context entries into a single LLM-ready document.
pub fn compact(
    kind: Option<&str>,
    tag: Option<&str>,
    output: Option<&str>,
    db_path: &str,
) -> Result<()> {
    let mgr = open_manager(db_path)?;

    let filter = ContextFilter {
        kind: kind.and_then(ContextKind::from_str),
        tag: tag.map(String::from),
        ..Default::default()
    };

    let result = mgr.compact(&filter)?;

    if let Some(out_path) = output {
        if let Some(parent) = std::path::Path::new(out_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(out_path, &result)?;
        eprintln!("Written to: {}", out_path);
    } else {
        println!("{}", result);
    }

    Ok(())
}

/// Show context store statistics.
pub fn stats(db_path: &str) -> Result<()> {
    let mgr = open_manager(db_path)?;
    let stats = mgr.stats()?;

    let token_estimate = stats.total_words * 4 / 3;

    println!("Context Store");
    println!("  Entries:  {}", stats.total_entries);
    println!("  Words:    {}", stats.total_words);
    println!("  Tokens:   ~{} (estimated)", token_estimate);
    println!();

    if !stats.by_kind.is_empty() {
        println!("By Kind:");
        for (kind, count) in &stats.by_kind {
            println!("  {:<12} {}", kind, count);
        }
        println!();
    }

    if !stats.by_source.is_empty() {
        println!("By Source:");
        for (source, count) in &stats.by_source {
            println!("  {:<12} {}", source, count);
        }
    }

    Ok(())
}

/// Import crawled content from gctrl-net as context entries.
pub fn import_crawl(domain: &str, db_path: &str) -> Result<()> {
    let mgr = open_manager(db_path)?;
    let site_store = gctrl_net::SiteStore::default_store()?;

    let index = site_store
        .load_index(domain)
        .ok_or_else(|| anyhow::anyhow!("crawled domain not found: {}. Use `gctrl net crawl` first.", domain))?;

    let pages = site_store.read_all_pages(domain)?;
    let source = ContextSource::Crawl { domain: domain.to_string() };
    let mut imported = 0;

    for (page_entry, raw_content) in &pages {
        // Strip frontmatter from stored pages
        let content = strip_frontmatter(raw_content);
        let rel_path = format!("crawls/{}/{}", domain, page_entry.file);

        mgr.upsert(
            &ContextKind::Document,
            &rel_path,
            &page_entry.title,
            content,
            &source,
            &["crawl".to_string(), domain.to_string()],
        )?;
        imported += 1;
    }

    println!(
        "Imported {} pages from {} ({} words)",
        imported, domain, index.total_words
    );

    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
    }
}

/// Strip YAML frontmatter from markdown content.
fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    if let Some(end) = content[3..].find("\n---") {
        let after = end + 3 + 4;
        if after < content.len() {
            return content[after..].trim_start_matches('\n');
        }
    }
    content
}
