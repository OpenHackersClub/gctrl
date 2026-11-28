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
    if let Ok(rest) = cwd.strip_prefix(home.join("wt")) {
        let name = basename(cwd);
        if let Some(parent) = rest.parent() {
            if !parent.as_os_str().is_empty() {
                return Some((home.join("workspaces").join(parent), name));
            }
        }
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

struct GitInfo {
    toplevel: Option<PathBuf>,
    linked_worktree: bool,
    origin: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_info(dir: &Path) -> GitInfo {
    let rev = git(
        dir,
        &["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    );
    let (toplevel, linked_worktree) = match rev {
        Some(out) => {
            let parts: Vec<&str> = out.lines().collect();
            let top = parts.first().map(PathBuf::from);
            let linked = match (parts.get(1), parts.get(2)) {
                (Some(gd), Some(cd)) => {
                    let gd = dir.join(gd);
                    let cd = dir.join(cd);
                    gd.canonicalize().ok() != cd.canonicalize().ok()
                }
                _ => false,
            };
            (top, linked)
        }
        None => (None, false),
    };
    let origin = toplevel
        .as_ref()
        .and_then(|_| git(dir, &["remote", "get-url", "origin"]));
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
            (Some(cwd.to_path_buf()), None)
        } else {
            match missing_cwd_candidate(&self.home, cwd) {
                Some((d, wt)) => (Some(d).filter(|d| d.is_dir()), wt),
                None => (None, None),
            }
        };
        let info = dir.as_deref().map(git_info);

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
