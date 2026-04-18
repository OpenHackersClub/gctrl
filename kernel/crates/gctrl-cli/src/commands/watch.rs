//! File watcher for board markdown directories.
//!
//! Watches `gctrl/{PROJECT_KEY}/*.md` and auto-imports on create/modify into
//! the SQLite board store (the source of truth for board data, and the
//! origin side of the SQLite → D1 sync).
//! Uses native OS file events (FSEvents on macOS, inotify on Linux).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gctrl_storage::SqliteStore;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;

/// Spawn a file watcher on `board_dir` that auto-imports markdown issues.
///
/// Expected layout:
///   board_dir/
///     BOARD/
///       BOARD-1.md
///       BOARD-2.md
///     INBOX/
///       INBOX-1.md
///
/// Each subdirectory name is a project key. Files are imported using
/// `gctrl_storage::import_markdown_dir` with content_hash dedup.
pub async fn watch_board_dir(store: Arc<SqliteStore>, board_dir: PathBuf) {
    if !board_dir.is_dir() {
        tracing::warn!("board dir not found: {} — file watcher disabled", board_dir.display());
        return;
    }

    tracing::info!("watching board dir: {}", board_dir.display());

    // Channel to receive file events from the sync watcher callback
    let (tx, mut rx) = mpsc::channel::<PathBuf>(64);

    let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in event.paths {
                        if path.extension().is_some_and(|ext| ext == "md") {
                            let _ = tx.blocking_send(path);
                        }
                    }
                }
                _ => {}
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("failed to create file watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&board_dir, RecursiveMode::Recursive) {
        tracing::error!("failed to watch {}: {e}", board_dir.display());
        return;
    }

    // Debounce: collect events for 500ms before processing
    loop {
        let Some(first_path) = rx.recv().await else {
            break; // channel closed
        };

        // Collect the subdirectory of the first changed file
        let mut changed_dirs = std::collections::HashSet::new();
        if let Some(parent) = first_path.parent() {
            changed_dirs.insert(parent.to_path_buf());
        }

        // Drain any more events that arrive within the debounce window
        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(path) = rx.try_recv() {
            if let Some(parent) = path.parent() {
                changed_dirs.insert(parent.to_path_buf());
            }
        }

        // Import each changed subdirectory
        for dir in &changed_dirs {
            import_subdir(&store, dir, &board_dir);
        }
    }

    // Keep watcher alive — dropping it stops watching
    drop(watcher);
}

/// Import a single project subdirectory (e.g. `gctrl/BOARD/`).
fn import_subdir(store: &SqliteStore, dir: &std::path::Path, board_dir: &std::path::Path) {
    // Derive project key from directory name
    let project_key = match dir.file_name().and_then(|n| n.to_str()) {
        Some(key) => key.to_uppercase(),
        None => return,
    };

    // Skip if this isn't a direct child of board_dir
    if dir.parent() != Some(board_dir) {
        return;
    }

    // Get or create the project
    let projects = match store.list_board_projects() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("failed to list projects: {e}");
            return;
        }
    };

    let project_exists = projects.iter().any(|p| p.key == project_key);
    if !project_exists {
        let project = gctrl_core::BoardProject {
            id: uuid::Uuid::new_v4().to_string(),
            name: project_key.clone(),
            key: project_key.clone(),
            counter: 0,
            github_repo: None,
        };
        if let Err(e) = store.create_board_project(&project) {
            tracing::error!("failed to auto-create project {project_key}: {e}");
            return;
        }
        tracing::info!("auto-created project: {project_key}");
    }

    // Re-fetch projects (may have just created one)
    let projects = match store.list_board_projects() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("failed to list projects: {e}");
            return;
        }
    };

    // Import markdown files
    let parsed = match gctrl_storage::import_markdown_dir(dir, &projects) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("import error in {}: {e}", dir.display());
            return;
        }
    };

    let mut imported = 0;
    let mut skipped = 0;
    for (issue, _id) in &parsed {
        match store.upsert_board_issue(issue) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => tracing::error!("upsert failed for {}: {e}", issue.id),
        }
    }

    if imported > 0 {
        tracing::info!(
            "board watch: {project_key}/ — {imported} imported, {skipped} skipped (total: {})",
            parsed.len()
        );
    }
}
