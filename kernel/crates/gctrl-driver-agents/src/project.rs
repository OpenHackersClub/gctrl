//! Project key and worktree resolution for a run's cwd. Rules: spec
//! § Project key. The rule matches `shell/hooks/claude-code-inbox.sh`, so
//! inbox messages and agent runs land in the same project.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub key: String,
    pub worktree: Option<String>,
}

/// Keep `[A-Za-z0-9._-]`, cut to 64 characters.
pub fn sanitize_key(raw: &str) -> String {
    let k: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(64)
        .collect();
    if k.is_empty() {
        "unknown".into()
    } else {
        k
    }
}

/// `git@github.com:acme/api.git` and `https://github.com/acme/api` → `api`.
pub fn slug_from_origin(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let slug = last.strip_suffix(".git").unwrap_or(last);
    (!slug.is_empty()).then(|| slug.to_string())
}

fn basename(p: &Path) -> Option<String> {
    p.file_name().and_then(|s| s.to_str()).map(str::to_string)
}

/// For a cwd that no longer exists, the checkout it belonged to and the
/// worktree name. `~/wt/<path>/<name>` maps to `~/workspaces/<path>`;
/// `<repo>/.claude/worktrees/<name>` maps to `<repo>`; anything else maps to
/// its nearest existing ancestor.
pub fn missing_cwd_candidate(home: &Path, cwd: &Path) -> Option<(PathBuf, Option<String>)> {
    if let Some(hit) = wt_checkout(home, cwd) {
        return Some(hit);
    }
    let s = cwd.to_str()?;
    if let Some((repo, wt)) = s.split_once("/.claude/worktrees/") {
        let name = wt.split('/').next().map(str::to_string);
        return Some((PathBuf::from(repo), name));
    }
    cwd.ancestors()
        .skip(1)
        .find(|a| a.is_dir())
        .map(|a| (a.to_path_buf(), None))
}

/// `~/wt/<path>/<name>` → (`~/workspaces/<path>`, `<name>`): a worktree and
/// the canonical checkout it was created from.
fn wt_checkout(home: &Path, cwd: &Path) -> Option<(PathBuf, Option<String>)> {
    let rest = cwd.strip_prefix(home.join("wt")).ok()?;
    let parent = rest.parent().filter(|p| !p.as_os_str().is_empty())?;
    Some((home.join("workspaces").join(parent), basename(cwd)))
}

/// True when `a` and `b` are on the same volume. macOS guards other volumes
/// (external disks, separately mounted APFS volumes) with a privacy prompt.
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev(),
        _ => false,
    }
}

struct GitInfo {
    toplevel: Option<PathBuf>,
    linked_worktree: bool,
    origin: Option<String>,
}

/// A git call that takes longer than this is abandoned; the index must not
/// wait on a slow or blocked repository.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    use std::process::Stdio;
    let child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id();
    // A helper thread blocks in wait(); the caller waits on the channel, so
    // the call returns the moment git exits. A sleep-and-poll loop would not:
    // macOS stretches short sleeps for a background launchd job.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(out)) => out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Ok(Err(_)) => None,
        Err(_) => {
            tracing::debug!(dir = %dir.display(), "git timed out");
            let _ = Command::new("/bin/kill").args(["-9", &pid.to_string()]).status();
            None
        }
    }
}

/// `url` of `[remote "origin"]` in a git config file.
fn origin_from_config(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_origin = t == r#"[remote "origin"]"#;
        } else if in_origin {
            if let Some((k, v)) = t.split_once('=') {
                if k.trim() == "url" {
                    return Some(v.trim().to_string()).filter(|u| !u.is_empty());
                }
            }
        }
    }
    None
}

/// Folders macOS guards with a privacy prompt. Reading inside them raises
/// that prompt for the kernel, and the read blocks until someone answers,
/// so the resolver runs no git there and keys the run by directory name.
fn privacy_protected(home: &Path, dir: &Path) -> bool {
    ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"]
        .iter()
        .any(|sub| dir.starts_with(home.join(sub)))
}

fn git_info(dir: &Path) -> GitInfo {
    let rev = git(
        dir,
        &["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    );
    let (toplevel, linked_worktree, common_dir) = match rev {
        Some(out) => {
            let parts: Vec<&str> = out.lines().collect();
            let top = parts.first().map(PathBuf::from);
            let common = parts.get(2).map(|cd| dir.join(cd));
            let linked = match (parts.get(1), &common) {
                (Some(gd), Some(cd)) => dir.join(gd).canonicalize().ok() != cd.canonicalize().ok(),
                _ => false,
            };
            (top, linked, common)
        }
        None => (None, false, None),
    };
    // The origin is read from the shared config file: one process per repo.
    let origin = common_dir
        .and_then(|cd| std::fs::read_to_string(cd.join("config")).ok())
        .and_then(|c| origin_from_config(&c));
    GitInfo {
        toplevel,
        linked_worktree,
        origin,
    }
}

/// Memoizes git lookups per (cwd, exists).
pub struct Resolver {
    home: PathBuf,
    cache: HashMap<(String, bool, Option<String>), Resolved>,
}

impl Resolver {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            cache: HashMap::new(),
        }
    }

    pub fn resolve(&mut self, cwd: &str, origin_hint: Option<&str>) -> Resolved {
        let exists = Path::new(cwd).is_dir();
        let key = (cwd.to_string(), exists, origin_hint.map(str::to_string));
        if let Some(r) = self.cache.get(&key) {
            return r.clone();
        }
        let r = self.compute(Path::new(cwd), exists, origin_hint);
        self.cache.insert(key, r.clone());
        r
    }

    fn compute(&self, cwd: &Path, exists: bool, origin_hint: Option<&str>) -> Resolved {
        let (dir, mapped_worktree) = if exists {
            // A worktree under ~/wt resolves through its canonical checkout:
            // same project key, and git runs on the home volume.
            match wt_checkout(&self.home, cwd) {
                Some((checkout, name)) if checkout.is_dir() => (Some(checkout), name),
                _ => (Some(cwd.to_path_buf()), None),
            }
        } else {
            match missing_cwd_candidate(&self.home, cwd) {
                Some((d, wt)) => (Some(d).filter(|d| d.is_dir()), wt),
                None => (None, None),
            }
        };
        let info = dir
            .as_deref()
            .filter(|d| !privacy_protected(&self.home, d) && same_volume(&self.home, d))
            .map(git_info);

        let origin = origin_hint
            .filter(|o| !o.is_empty())
            .map(str::to_string)
            .or_else(|| info.as_ref().and_then(|i| i.origin.clone()));
        let key = origin
            .as_deref()
            .and_then(slug_from_origin)
            .or_else(|| {
                info.as_ref()
                    .and_then(|i| i.toplevel.as_deref())
                    .and_then(basename)
            })
            .or_else(|| basename(cwd))
            .unwrap_or_default();

        let worktree = mapped_worktree.or_else(|| {
            let i = info.as_ref()?;
            if exists && i.linked_worktree {
                i.toplevel.as_deref().and_then(basename)
            } else {
                None
            }
        });

        Resolved {
            key: sanitize_key(&key),
            worktree,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug_from_origin("git@github.com:acme/api.git").as_deref(), Some("api"));
        assert_eq!(slug_from_origin("https://github.com/acme/api").as_deref(), Some("api"));
        assert_eq!(slug_from_origin("https://github.com/acme/api/").as_deref(), Some("api"));
        assert_eq!(slug_from_origin(""), None);
    }

    #[test]
    fn sanitizes() {
        assert_eq!(sanitize_key("my repo!"), "myrepo");
        assert_eq!(sanitize_key(""), "unknown");
        assert_eq!(sanitize_key(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn missing_wt_maps_to_workspaces() {
        let home = Path::new("/Users/me");
        let got = missing_cwd_candidate(home, Path::new("/Users/me/wt/acme/api/fix-login"));
        assert_eq!(
            got,
            Some((PathBuf::from("/Users/me/workspaces/acme/api"), Some("fix-login".into())))
        );
    }

    #[test]
    fn missing_claude_worktree_maps_to_repo() {
        let home = Path::new("/Users/me");
        let got = missing_cwd_candidate(
            home,
            Path::new("/Users/me/src/api/.claude/worktrees/feat-x"),
        );
        assert_eq!(
            got,
            Some((PathBuf::from("/Users/me/src/api"), Some("feat-x".into())))
        );
    }

    #[test]
    fn reads_origin_from_git_config() {
        let cfg = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:up/x.git\n[remote \"origin\"]\n\turl = git@github.com:acme/payments.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
        assert_eq!(origin_from_config(cfg).as_deref(), Some("git@github.com:acme/payments.git"));
        assert_eq!(origin_from_config("[core]\n"), None);
    }

    #[test]
    fn existing_wt_worktree_resolves_through_its_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let checkout = home.join("workspaces/acme/api");
        let worktree = home.join("wt/acme/api/fix-login");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        for args in [
            &["init", "-q"][..],
            &["remote", "add", "origin", "git@github.com:acme/payments.git"][..],
        ] {
            assert!(Command::new("git").arg("-C").arg(&checkout).args(args).status().unwrap().success());
        }
        let mut r = Resolver::new(home.to_path_buf());
        let got = r.resolve(worktree.to_str().unwrap(), None);
        assert_eq!(got.key, "payments");
        assert_eq!(got.worktree.as_deref(), Some("fix-login"));
    }

    #[test]
    fn skips_git_in_privacy_protected_folders() {
        let home = Path::new("/Users/me");
        assert!(privacy_protected(home, Path::new("/Users/me/Documents/Codex/2026-09-06/we")));
        assert!(privacy_protected(home, Path::new("/Users/me/Desktop/demo")));
        assert!(!privacy_protected(home, Path::new("/Users/me/workspaces/acme/api")));
        assert!(!privacy_protected(home, Path::new("/Users/me/DocumentsArchive")));

        // A git repo inside Documents keys by its directory name, not origin.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("Documents").join("scratch");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            &["init", "-q"][..],
            &["remote", "add", "origin", "git@github.com:acme/payments.git"][..],
        ] {
            assert!(Command::new("git").arg("-C").arg(&repo).args(args).status().unwrap().success());
        }
        let mut r = Resolver::new(tmp.path().to_path_buf());
        assert_eq!(r.resolve(repo.to_str().unwrap(), None).key, "scratch");
    }

    #[test]
    fn resolves_real_git_repo_and_linked_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["remote", "add", "origin", "git@github.com:acme/payments.git"]);
        run(
            &repo,
            &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
        );
        let wt = tmp.path().join("fix-login");
        run(&repo, &["worktree", "add", "-q", wt.to_str().unwrap()]);

        let mut r = Resolver::new(tmp.path().to_path_buf());
        let main = r.resolve(repo.to_str().unwrap(), None);
        assert_eq!(main, Resolved { key: "payments".into(), worktree: None });
        let linked = r.resolve(wt.to_str().unwrap(), None);
        assert_eq!(
            linked,
            Resolved { key: "payments".into(), worktree: Some("fix-login".into()) }
        );
        let hinted = r.resolve("/nonexistent/x", Some("https://github.com/acme/billing.git"));
        assert_eq!(hinted.key, "billing");
    }
}
