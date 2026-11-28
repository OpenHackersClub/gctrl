//! Session maps the Claude Code session-map mod keeps for `--resume`, read
//! from `<config>/plugins/store/session-map_*.json` in every Claude config
//! dir. Each file holds `order` (session ids) and `map:<session id>` →
//! `{shape, map}`, where `map` carries `goal`, `isGoalPinned`,
//! `goalPausedFor`, `status`, `summary`, `steps`, `handoffs`, `refs`,
//! `reports`, `where` and `updatedAt`. Fields are read leniently, so a map
//! of a newer shape still contributes what it shares with this one. The
//! driver never writes the store.

use crate::adapter::from_ms;
use crate::model::{MapHandoff, MapRef, MapReport, MapStep, SessionMap};
use crate::text::clip;
use chrono::SecondsFormat;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
}

/// One stored map in the gctrl shape.
pub fn parse_map(v: &Value) -> Option<SessionMap> {
    let v = v.as_object()?;
    let v = Value::Object(v.clone());
    let list = |k: &str| {
        v.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let steps = list("steps")
        .iter()
        .filter_map(|st| {
            Some(MapStep {
                text: clip(&s(st, "text")?, 200),
                status: match st.get("status").and_then(Value::as_str) {
                    Some(x @ ("completed" | "in_progress")) => x.into(),
                    _ => "pending".into(),
                },
            })
        })
        .collect();
    let handoffs = list("handoffs")
        .iter()
        .filter_map(|h| {
            Some(MapHandoff {
                who: s(h, "who")?,
                kind: s(h, "type").filter(|t| matches!(t.as_str(), "signoff" | "ops" | "task"))?,
                action: clip(&s(h, "action")?, 300),
                why: s(h, "why").map(|w| clip(&w, 300)),
                n: h.get("n").and_then(Value::as_u64).map(|n| n as u32),
                pinned: h.get("isPinned").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    let refs = list("refs")
        .iter()
        .filter_map(|r| {
            Some(MapRef {
                kind: s(r, "kind")?,
                repo: s(r, "repo")?,
                number: r.get("number").and_then(Value::as_u64)?,
                url: s(r, "url")?,
                roles: r
                    .get("roles")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                title: s(r, "title").map(|t| clip(&t, 200)),
                state: s(r, "state"),
            })
        })
        .collect();
    let reports = list("reports")
        .iter()
        .filter_map(|r| {
            Some(MapReport {
                slug: s(r, "slug")?,
                url: s(r, "url").or_else(|| s(r, "local")),
                path: s(r, "path"),
                unanswered: r
                    .get("unanswered")
                    .and_then(Value::as_u64)
                    .map(|n| n as u32),
                done: r.get("isDone").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    let place = v.get("where").cloned().unwrap_or(Value::Null);
    Some(SessionMap {
        source: "session-map".into(),
        name: s(&v, "name"),
        goal: s(&v, "goal").map(|g| clip(&g, 300)),
        goal_pinned: v
            .get("isGoalPinned")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        goal_paused_for: s(&v, "goalPausedFor"),
        status: s(&v, "status"),
        summary: s(&v, "summary").map(|x| clip(&x, 300)),
        steps,
        handoffs,
        refs,
        reports,
        repo: s(&place, "repo"),
        branch: s(&place, "branch"),
        updated_at: v
            .get("updatedAt")
            .and_then(Value::as_i64)
            .map(|ms| from_ms(ms).to_rfc3339_opts(SecondsFormat::Millis, true)),
    })
}

/// Session id → map, from one store file.
pub fn parse_store(store: &Value) -> HashMap<String, SessionMap> {
    let Some(obj) = store.as_object() else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(k, v)| {
            let id = k.strip_prefix("map:")?.to_ascii_lowercase();
            Some((id, parse_map(v.get("map")?)?))
        })
        .collect()
}

/// Store files under `config_dirs`, read again only when they change.
#[derive(Default)]
pub struct MapStores {
    files: HashMap<PathBuf, (Option<SystemTime>, HashMap<String, SessionMap>)>,
}

fn store_files(config: &Path) -> Vec<PathBuf> {
    let dir = config.join("plugins").join("store");
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("session-map_") && n.ends_with(".json"))
                })
                .collect()
        })
        .unwrap_or_default()
}

impl MapStores {
    /// Every stored map across `config_dirs`. When two stores hold the same
    /// session, the one updated last wins.
    pub fn read(&mut self, config_dirs: &[PathBuf]) -> HashMap<String, SessionMap> {
        let mut seen = Vec::new();
        for dir in config_dirs {
            for file in store_files(dir) {
                let mtime = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
                let fresh = self.files.get(&file).is_some_and(|(m, _)| *m == mtime);
                if !fresh {
                    let maps = std::fs::read(&file)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                        .map(|v| parse_store(&v))
                        .unwrap_or_default();
                    self.files.insert(file.clone(), (mtime, maps));
                }
                seen.push(file);
            }
        }
        self.files.retain(|p, _| seen.contains(p));
        let mut out: HashMap<String, SessionMap> = HashMap::new();
        for (_, maps) in self.files.values() {
            for (id, m) in maps {
                match out.get(id) {
                    Some(cur) if cur.updated_at >= m.updated_at => {}
                    _ => {
                        out.insert(id.clone(), m.clone());
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store(goal: &str, updated: i64) -> Value {
        json!({
            "order": ["e2e6333f-4819-43cd-8be0-b0ea767f397b"],
            "map:E2E6333F-4819-43CD-8BE0-B0EA767F397B": {"shape": "map-3", "map": {
                "sessionId": "e2e6333f-4819-43cd-8be0-b0ea767f397b",
                "name": "s-panel", "goal": goal, "isGoalPinned": true,
                "status": "active", "summary": "building",
                "steps": [{"text": "scan", "status": "completed"}, {"text": "pane", "status": "in_progress"}],
                "handoffs": [
                    {"who": "operator", "type": "ops", "action": "Grant Accessibility", "why": "binary swap", "n": 1},
                    {"who": "codex", "type": "task", "action": "Fix lipo"},
                    {"who": "x", "type": "nonsense", "action": "dropped"}
                ],
                "refs": [{"kind": "pr", "repo": "acme/api", "number": 243, "url": "https://github.com/acme/api/pull/243", "roles": ["created"], "state": "MERGED", "title": "feat: panel"}],
                "reports": [{"slug": "plan", "url": "https://r.example/plan", "unanswered": 2}],
                "where": {"cwd": "/w/api", "repo": "acme/api", "branch": "main"},
                "updatedAt": updated
            }}
        })
    }

    #[test]
    fn parses_a_stored_map() {
        let maps = parse_store(&store("ship the panel", 1_795_857_072_279));
        let m = &maps["e2e6333f-4819-43cd-8be0-b0ea767f397b"];
        assert_eq!(m.source, "session-map");
        assert_eq!(m.name.as_deref(), Some("s-panel"));
        assert!(m.goal_pinned);
        assert_eq!(m.handoffs.len(), 2);
        assert_eq!(m.handoffs[0].n, Some(1));
        assert_eq!(m.refs[0].state.as_deref(), Some("MERGED"));
        assert_eq!(m.reports[0].unanswered, Some(2));
        assert_eq!(
            (m.repo.as_deref(), m.branch.as_deref()),
            (Some("acme/api"), Some("main"))
        );
        assert!(m.updated_at.as_deref().unwrap().starts_with("2026-11-"));
        let p = m.progress();
        assert_eq!(p.current_step.as_deref(), Some("pane"));
        assert_eq!((p.steps_done, p.steps_total), (1, 2));
    }

    #[test]
    fn newest_store_wins_across_config_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        for (dir, goal, at) in [(&a, "old", 1_000), (&b, "new", 2_000)] {
            let d = dir.join("plugins/store");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("session-map_df-harness-x.json"),
                store(goal, at).to_string(),
            )
            .unwrap();
            std::fs::write(d.join("other-plugin.json"), "{}").unwrap();
        }
        let mut stores = MapStores::default();
        let maps = stores.read(&[a, b]);
        assert_eq!(maps.len(), 1);
        assert_eq!(maps.values().next().unwrap().goal.as_deref(), Some("new"));
    }
}
