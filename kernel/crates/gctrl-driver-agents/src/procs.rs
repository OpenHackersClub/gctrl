//! Process table probe: `ps` for pid, start time, tty and argv; `lsof` for
//! the working directory of Codex processes.

use std::collections::HashMap;
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    /// `lstart` with whitespace collapsed, e.g. `Fri Nov 27 10:30:03 2026`.
    pub lstart: String,
    /// `/dev/ttysNNN`, or `None` for processes without a controlling tty.
    pub tty: Option<String>,
    pub command: String,
}

/// Collapse runs of whitespace so `Fri Nov  7 …` equals `Fri Nov 7 …`.
pub fn normalize_lstart(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse `ps -axo pid=,lstart=,tty=,command=` output.
pub fn parse_ps(out: &str) -> Vec<Proc> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid: u32 = it.next()?.parse().ok()?;
            let lstart: Vec<&str> = it.by_ref().take(5).collect();
            if lstart.len() != 5 {
                return None;
            }
            let tty = it.next()?;
            let command: Vec<&str> = it.collect();
            Some(Proc {
                pid,
                lstart: lstart.join(" "),
                tty: (tty != "??" && tty != "-").then(|| format!("/dev/{tty}")),
                command: command.join(" "),
            })
        })
        .collect()
}

pub fn snapshot() -> HashMap<u32, Proc> {
    // Claude Code records `procStart` as C-locale `lstart` in UTC; matching
    // that format is what lets a reused pid be told apart after a reboot.
    let out = Command::new("ps")
        .args(["-axo", "pid=,lstart=,tty=,command="])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .output();
    match out {
        Ok(o) if o.status.success() => parse_ps(&String::from_utf8_lossy(&o.stdout))
            .into_iter()
            .map(|p| (p.pid, p))
            .collect(),
        Ok(o) => {
            tracing::warn!(status = %o.status, "ps failed");
            HashMap::new()
        }
        Err(e) => {
            tracing::warn!(error = %e, "ps unavailable");
            HashMap::new()
        }
    }
}

/// The executable's basename, from the first argv token.
fn exe_name(command: &str) -> &str {
    let first = command.split_whitespace().next().unwrap_or("");
    first.rsplit('/').next().unwrap_or(first)
}

/// True for a Codex CLI process. App bundles (Codex Desktop, the browser
/// extension host) are excluded.
pub fn is_codex_cli(p: &Proc) -> bool {
    exe_name(&p.command) == "codex" && !p.command.split_whitespace().next().unwrap_or("").contains(".app/")
}

/// True for a Claude Code CLI process.
pub fn is_claude_cli(p: &Proc) -> bool {
    exe_name(&p.command) == "claude"
}

fn is_interpreter(exe: &str) -> bool {
    matches!(exe, "node" | "bun" | "deno" | "python" | "python3")
        || exe.strip_prefix("python3.").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit()))
}

/// True when the process runs the program `name`: its executable is `name`,
/// or an interpreter runs a script named `name` (`python3 …/bin/hermes`,
/// `node …/bin/pi`).
pub fn runs_program(p: &Proc, name: &str) -> bool {
    let mut it = p.command.split_whitespace();
    let base = |t: &str| t.rsplit('/').next().unwrap_or(t).to_string();
    let Some(exe) = it.next().map(base) else {
        return false;
    };
    if exe == name {
        return true;
    }
    is_interpreter(&exe) && it.next().map(base).is_some_and(|s| s == name)
}

/// True for a Hermes Agent CLI or TUI process.
pub fn is_hermes_cli(p: &Proc) -> bool {
    runs_program(p, "hermes")
}

/// True for a Pi coding agent process.
pub fn is_pi_cli(p: &Proc) -> bool {
    runs_program(p, "pi")
}

/// True for a login shell or interactive shell, the processes left on a tty
/// after its agent exits.
pub fn is_shell(p: &Proc) -> bool {
    let exe = exe_name(&p.command).trim_start_matches('-');
    matches!(exe, "login" | "zsh" | "bash" | "fish" | "sh" | "nu" | "tcsh" | "ksh")
}

/// Parse `lsof -a -d cwd -Fpn -p <pids>` output into pid → cwd.
pub fn parse_lsof_cwd(out: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let mut pid: Option<u32> = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok();
        } else if let Some(path) = line.strip_prefix('n') {
            if let Some(p) = pid {
                map.insert(p, path.to_string());
            }
        }
    }
    map
}

pub fn cwds(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    match Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fpn", "-p", &list])
        .output()
    {
        Ok(o) => parse_lsof_cwd(&String::from_utf8_lossy(&o.stdout)),
        Err(e) => {
            tracing::warn!(error = %e, "lsof unavailable");
            HashMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "    1 Mon Nov 16 08:00:00 2026     ??  /sbin/launchd
34455 Fri Nov 27 10:30:03 2026 ttys003  claude --resume 26e3373e-8358-416b-83f3-355a59325193
 4100 Fri Nov  7 09:01:02 2026 ttys010  /Users/me/.codex/packages/standalone/current/bin/codex --no-daemon resume 01a04c15-4628-7913-bd1d-21ed78284c55
47024 Fri Nov 27 09:00:00 2026     ??  /Applications/Codex.app/Contents/MacOS/codex app-server
";

    #[test]
    fn parses_ps_rows() {
        let procs = parse_ps(PS);
        assert_eq!(procs.len(), 4);
        assert_eq!(procs[1].pid, 34455);
        assert_eq!(procs[1].lstart, "Fri Nov 27 10:30:03 2026");
        assert_eq!(procs[1].tty.as_deref(), Some("/dev/ttys003"));
        assert_eq!(procs[0].tty, None);
        assert_eq!(procs[2].lstart, "Fri Nov 7 09:01:02 2026");
    }

    #[test]
    fn classifies_harness_processes() {
        let procs = parse_ps(PS);
        assert!(is_claude_cli(&procs[1]));
        assert!(is_codex_cli(&procs[2]));
        assert!(!is_codex_cli(&procs[3]));
        assert!(!is_codex_cli(&procs[0]));
    }

    #[test]
    fn classifies_interpreted_harnesses() {
        let p = |c: &str| Proc { pid: 1, lstart: String::new(), tty: None, command: c.into() };
        assert!(is_hermes_cli(&p("/h/venv/bin/python3 /h/venv/bin/hermes --resume x")));
        assert!(is_hermes_cli(&p("/h/venv/bin/python3.12 /h/venv/bin/hermes")));
        assert!(!is_hermes_cli(&p("/h/venv/bin/python3 -m pip install hermes")));
        assert!(is_pi_cli(&p("node /opt/homebrew/bin/pi --session abc")));
        assert!(is_pi_cli(&p("pi")));
        assert!(!is_pi_cli(&p("/usr/bin/pip install x")));
        assert!(is_shell(&p("-zsh")));
        assert!(is_shell(&p("login -pfl me /bin/zsh")));
        assert!(!is_shell(&p("claude --resume x")));
    }

    #[test]
    fn normalizes_lstart() {
        assert_eq!(
            normalize_lstart("Fri Nov  7 09:01:02 2026"),
            "Fri Nov 7 09:01:02 2026"
        );
    }

    #[test]
    fn parses_lsof_cwd() {
        let out = "p4100\nfcwd\nn/Users/me/src/api\np4200\nfcwd\nn/tmp/x y\n";
        let map = parse_lsof_cwd(out);
        assert_eq!(map.get(&4100).map(String::as_str), Some("/Users/me/src/api"));
        assert_eq!(map.get(&4200).map(String::as_str), Some("/tmp/x y"));
    }
}
