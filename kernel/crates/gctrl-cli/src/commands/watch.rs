//! File watcher for vault markdown directories.
//!
//! Walks every row in `gctrl_vault_mounts` and spawns one watcher per mount.
//! Each mount's `root_path` is treated like the legacy board dir: subdirectories
//! become project keys, and `.md` files inside them are auto-imported via
//! `gctrl_storage::import_markdown_dir` with content_hash dedup.
//!
//! Layout for a single mount:
//!   {mount.root_path}/
//!     BOARD/
//!       BOARD-1.md
//!     INBOX/
//!       INBOX-1.md
//!
//! Uses native OS file events (FSEvents on macOS, inotify on Linux).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gctrl_core::VaultMount;
use gctrl_storage::SqliteStore;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;

/// List every registered vault mount and spawn one watcher per row.
///
/// Resilient: a launch failure on one mount logs and skips that mount;
/// the others keep running. Empty list logs and returns (no panic).
pub async fn watch_all_vault_mounts(store: Arc<SqliteStore>) {
    let mounts = match store.list_vault_mounts() {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = %e, "failed to list vault mounts — file watcher disabled");
            return;
        }
    };

    if mounts.is_empty() {
        tracing::info!("no vault mounts registered — file watcher idle");
        return;
    }

    tracing::info!("starting file watchers for {} vault mount(s)", mounts.len());
    for mount in mounts {
        let mount_store = Arc::clone(&store);
        tokio::spawn(async move {
            watch_vault_mount(mount_store, mount).await;
        });
    }
}

/// Spawn a file watcher rooted at `mount.root_path`. Each direct subdirectory
/// of the root is treated as a project key (same semantics as the legacy
/// board-dir watcher). Failures log and exit this task only — sibling
/// watchers keep running.
pub async fn watch_vault_mount(store: Arc<SqliteStore>, mount: VaultMount) {
    let root_input = PathBuf::from(&mount.root_path);
    if !root_input.is_dir() {
        tracing::warn!(
            mount = %mount.name,
            path = %root_input.display(),
            "vault mount root not found — watcher disabled for this mount"
        );
        return;
    }

    // Canonicalize so that path comparisons against events from notify (which
    // on macOS resolves `/var` → `/private/var` via FSEvents) line up with
    // the watcher's root.
    let root = match std::fs::canonicalize(&root_input) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(
                mount = %mount.name,
                path = %root_input.display(),
                error = %e,
                "failed to canonicalize vault mount root"
            );
            return;
        }
    };

    tracing::info!(
        mount = %mount.name,
        path = %root.display(),
        "watching vault mount"
    );

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
            tracing::error!(
                mount = %mount.name,
                error = %e,
                "failed to create file watcher"
            );
            return;
        }
    };

    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        tracing::error!(
            mount = %mount.name,
            path = %root.display(),
            error = %e,
            "failed to watch vault mount root"
        );
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
            import_subdir(&store, dir, &root, &mount.name);
        }
    }

    // Keep watcher alive — dropping it stops watching
    drop(watcher);
}

/// Import a single project subdirectory (e.g. `{mount_root}/BOARD/`).
fn import_subdir(
    store: &SqliteStore,
    dir: &Path,
    mount_root: &Path,
    mount_name: &str,
) {
    // Derive project key from directory name
    let project_key = match dir.file_name().and_then(|n| n.to_str()) {
        Some(key) => key.to_uppercase(),
        None => return,
    };

    // Skip if this isn't a direct child of the mount root
    if dir.parent() != Some(mount_root) {
        return;
    }

    // Get or create the project
    let projects = match store.list_board_projects() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(mount = %mount_name, error = %e, "failed to list projects");
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
            tracing::error!(
                mount = %mount_name,
                project = %project_key,
                error = %e,
                "failed to auto-create project"
            );
            return;
        }
        tracing::info!(mount = %mount_name, project = %project_key, "auto-created project");
    }

    // Re-fetch projects (may have just created one)
    let projects = match store.list_board_projects() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(mount = %mount_name, error = %e, "failed to list projects");
            return;
        }
    };

    // Import markdown files
    let parsed = match gctrl_storage::import_markdown_dir(dir, &projects) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                mount = %mount_name,
                dir = %dir.display(),
                error = %e,
                "import error"
            );
            return;
        }
    };

    let mut imported = 0;
    let mut skipped = 0;
    for (issue, _id) in &parsed {
        match store.upsert_board_issue(issue) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => tracing::error!(
                mount = %mount_name,
                issue = %issue.id,
                error = %e,
                "upsert failed"
            ),
        }
    }

    if imported > 0 {
        tracing::info!(
            mount = %mount_name,
            project = %project_key,
            imported,
            skipped,
            total = parsed.len(),
            "vault watch imported issues"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctrl_core::VaultMountKind;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::time::sleep;

    fn make_mount(id: &str, name: &str, root: &Path) -> VaultMount {
        let now = Utc::now();
        VaultMount {
            id: id.into(),
            name: name.into(),
            root_path: root.to_string_lossy().into_owned(),
            kind: VaultMountKind::App,
            git_url: None,
            app_id: None,
            last_commit_sha: None,
            last_synced_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn issue_md(key: &str, project: &str, n: u32) -> String {
        format!(
            "---\nid: {key}-{n}\nproject: {project}\ntitle: Issue {n}\nstatus: todo\n---\n\n# Issue {n}\n\nbody\n",
            key = key,
            n = n,
            project = project
        )
    }

    #[tokio::test]
    async fn watch_all_vault_mounts_empty_list_no_panic() {
        let store = Arc::new(SqliteStore::open(":memory:").unwrap());
        // No mounts registered — should log and return cleanly
        watch_all_vault_mounts(store).await;
    }

    #[tokio::test]
    async fn watch_all_vault_mounts_imports_under_each_mount() {
        // Two mounts, each with one project subdir; write a .md file in each
        // and assert both get imported under their respective project keys.
        let store = Arc::new(SqliteStore::open(":memory:").unwrap());

        let tmp_a = TempDir::new().unwrap();
        let tmp_b = TempDir::new().unwrap();

        // Pre-create the project subdirs (mount A → AAA, mount B → BBB)
        let proj_a_dir = tmp_a.path().join("AAA");
        let proj_b_dir = tmp_b.path().join("BBB");
        std::fs::create_dir_all(&proj_a_dir).unwrap();
        std::fs::create_dir_all(&proj_b_dir).unwrap();

        store
            .create_vault_mount(&make_mount("m-a", "mount-a", tmp_a.path()))
            .unwrap();
        store
            .create_vault_mount(&make_mount("m-b", "mount-b", tmp_b.path()))
            .unwrap();

        // Spawn the watcher orchestrator
        watch_all_vault_mounts(Arc::clone(&store)).await;

        // Give the watchers a moment to register with the OS
        sleep(Duration::from_millis(300)).await;

        // Write a file in each mount
        std::fs::write(proj_a_dir.join("AAA-1.md"), issue_md("AAA", "AAA", 1)).unwrap();
        std::fs::write(proj_b_dir.join("BBB-1.md"), issue_md("BBB", "BBB", 1)).unwrap();

        // Wait for debounce + import: 500ms debounce + slack
        sleep(Duration::from_millis(2000)).await;

        let projects = store.list_board_projects().unwrap();
        let project_keys: std::collections::HashSet<_> =
            projects.iter().map(|p| p.key.as_str()).collect();
        assert!(
            project_keys.contains("AAA"),
            "expected AAA project to be auto-created, got {project_keys:?}"
        );
        assert!(
            project_keys.contains("BBB"),
            "expected BBB project to be auto-created, got {project_keys:?}"
        );

        // Assert at least one issue exists per project
        let aaa = projects.iter().find(|p| p.key == "AAA").unwrap();
        let bbb = projects.iter().find(|p| p.key == "BBB").unwrap();
        let aaa_filter = gctrl_core::BoardIssueFilter {
            project_id: Some(aaa.id.clone()),
            ..Default::default()
        };
        let bbb_filter = gctrl_core::BoardIssueFilter {
            project_id: Some(bbb.id.clone()),
            ..Default::default()
        };
        let aaa_issues = store.list_board_issues(&aaa_filter).unwrap();
        let bbb_issues = store.list_board_issues(&bbb_filter).unwrap();
        assert!(!aaa_issues.is_empty(), "AAA issues should be imported");
        assert!(!bbb_issues.is_empty(), "BBB issues should be imported");
    }
}
