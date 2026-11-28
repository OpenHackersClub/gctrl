//! Session maps reported to the kernel by any harness through
//! `POST /api/agents/{id}/map`. The body takes the fields of the Claude Code
//! session-map update tool (`goal`, `status`, `summary`, `name`, `steps`)
//! plus `handoffs`, `clearHandoffs`, `refs`, `repo`, `branch` and `reply`;
//! fields left out keep their value, and a list replaces the stored list.
//! `reply` is the text of the agent's final reply: its hand-off table, when
//! it has one, replaces the hand-offs that are not pinned. Each map is kept
//! as `<maps dir>/<harness>_<native id>.json`.

use crate::handoff_table;
use crate::model::{Harness, MapHandoff, MapRef, MapStep, SessionMap};
use crate::text::clip;
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_STEPS: usize = 50;
const MAX_HANDOFFS: usize = 30;
const MAX_REFS: usize = 40;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapUpdate {
    pub goal: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub name: Option<String>,
    pub steps: Option<Vec<MapStep>>,
    pub handoffs: Option<Vec<MapHandoff>>,
    #[serde(alias = "clear_handoffs")]
    pub clear_handoffs: Option<bool>,
    pub refs: Option<Vec<MapRef>>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub reply: Option<String>,
}

/// `<harness prefix>:<native id>` with a known prefix and a safe native id.
pub fn valid_run_id(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re =
        RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").expect("valid regex"));
    id.split_once(':').is_some_and(|(prefix, native)| {
        Harness::ALL.iter().any(|h| h.prefix() == prefix) && re.is_match(native)
    })
}

fn file_name(id: &str) -> String {
    format!("{}.json", id.replacen(':', "_", 1))
}

/// Apply `upd` to `map`. Errors name the first invalid field.
pub fn apply(map: &mut SessionMap, upd: MapUpdate) -> Result<(), String> {
    let text = |v: String, max: usize| Some(clip(v.trim(), max)).filter(|t| !t.is_empty());
    if let Some(st) = &upd.status {
        if !matches!(st.as_str(), "active" | "blocked" | "handoff" | "done") {
            return Err("status must be active, blocked, handoff or done".into());
        }
    }
    if let Some(steps) = &upd.steps {
        if steps.len() > MAX_STEPS {
            return Err(format!("at most {MAX_STEPS} steps"));
        }
        if steps
            .iter()
            .any(|s| !matches!(s.status.as_str(), "pending" | "in_progress" | "completed"))
        {
            return Err("step status must be pending, in_progress or completed".into());
        }
    }
    if let Some(h) = &upd.handoffs {
        if h.len() > MAX_HANDOFFS {
            return Err(format!("at most {MAX_HANDOFFS} hand-offs"));
        }
        if h.iter()
            .any(|x| !matches!(x.kind.as_str(), "signoff" | "ops" | "task"))
        {
            return Err("hand-off type must be signoff, ops or task".into());
        }
    }
    if upd.refs.as_ref().is_some_and(|r| r.len() > MAX_REFS) {
        return Err(format!("at most {MAX_REFS} refs"));
    }
    map.source = "kernel".into();
    if let Some(v) = upd.goal {
        map.goal = text(v, 300);
    }
    if let Some(v) = upd.status {
        map.status = Some(v);
    }
    if let Some(v) = upd.summary {
        map.summary = text(v, 300);
    }
    if let Some(v) = upd.name {
        map.name = text(v, 80);
    }
    if let Some(v) = upd.repo {
        map.repo = text(v, 120);
    }
    if let Some(v) = upd.branch {
        map.branch = text(v, 120);
    }
    if let Some(steps) = upd.steps {
        map.steps = steps
            .into_iter()
            .map(|s| MapStep {
                text: clip(&s.text, 200),
                status: s.status,
            })
            .collect();
    }
    if upd.clear_handoffs == Some(true) {
        map.handoffs.retain(|h| h.pinned);
    }
    if let Some(rows) = upd.reply.as_deref().and_then(handoff_table::parse) {
        map.handoffs.retain(|h| h.pinned);
        let room = MAX_HANDOFFS.saturating_sub(map.handoffs.len());
        map.handoffs.extend(rows.into_iter().take(room));
    }
    if let Some(h) = upd.handoffs {
        map.handoffs = h
            .into_iter()
            .map(|x| MapHandoff {
                action: clip(&x.action, 300),
                why: x.why.map(|w| clip(&w, 300)),
                who: clip(&x.who, 80),
                ..x
            })
            .collect();
    }
    if let Some(r) = upd.refs {
        map.refs = r
            .into_iter()
            .filter(|x| x.url.starts_with("https://"))
            .collect();
    }
    map.updated_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    Ok(())
}

pub struct KernelMaps {
    dir: PathBuf,
    maps: Mutex<HashMap<String, SessionMap>>,
}

impl KernelMaps {
    /// Load every map already kept under `dir`.
    pub fn open(dir: PathBuf) -> Self {
        let mut maps = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let id = stem.replacen('_', ":", 1);
                if !valid_run_id(&id) {
                    continue;
                }
                if let Some(m) = std::fs::read(&p)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<SessionMap>(&b).ok())
                {
                    maps.insert(id, m);
                }
            }
        }
        Self {
            dir,
            maps: Mutex::new(maps),
        }
    }

    pub fn all(&self) -> HashMap<String, SessionMap> {
        self.maps.lock().expect("maps lock").clone()
    }

    /// Apply an update to run `id` and keep the result on disk.
    pub fn update(&self, id: &str, upd: MapUpdate) -> Result<SessionMap, String> {
        if !valid_run_id(id) {
            return Err("id must be <harness>:<native id> with a known harness".into());
        }
        let mut maps = self.maps.lock().expect("maps lock");
        let mut map = maps.get(id).cloned().unwrap_or_default();
        apply(&mut map, upd)?;
        write_atomic(&self.dir, &file_name(id), &map).map_err(|e| format!("store: {e}"))?;
        maps.insert(id.to_string(), map.clone());
        Ok(map)
    }
}

fn write_atomic(dir: &Path, name: &str, map: &SessionMap) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(map)?)?;
    std::fs::rename(tmp, dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn upd(v: serde_json::Value) -> MapUpdate {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn validates_run_ids() {
        assert!(valid_run_id("codex:01a04c15-4628-7913-bd1d-21ed78284c55"));
        assert!(valid_run_id("hermes:20260420_134853_5501ee"));
        assert!(!valid_run_id("other:abc"));
        assert!(!valid_run_id("codex:../etc"));
        assert!(!valid_run_id("codex"));
    }

    #[test]
    fn merges_updates_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let maps = KernelMaps::open(tmp.path().to_path_buf());
        let id = "codex:01a04c15-4628-7913-bd1d-21ed78284c55";
        maps.update(id, upd(json!({"goal": "Fix billing", "status": "active",
            "steps": [{"text": "repro", "status": "completed"}, {"text": "patch", "status": "in_progress"}],
            "handoffs": [{"who": "operator", "type": "signoff", "action": "Approve the migration", "n": 1}]})))
            .unwrap();
        let m = maps
            .update(id, upd(json!({"summary": "patch written"})))
            .unwrap();
        assert_eq!(m.source, "kernel");
        assert_eq!(m.goal.as_deref(), Some("Fix billing"));
        assert_eq!(m.summary.as_deref(), Some("patch written"));
        assert_eq!(m.progress().current_step.as_deref(), Some("patch"));
        assert_eq!(m.handoffs.len(), 1);
        let cleared = maps
            .update(id, upd(json!({"clearHandoffs": true})))
            .unwrap();
        assert!(cleared.handoffs.is_empty());

        // A new instance reads the map back from disk.
        let again = KernelMaps::open(tmp.path().to_path_buf());
        assert_eq!(again.all()[id].goal.as_deref(), Some("Fix billing"));
    }

    #[test]
    fn a_reply_table_replaces_unpinned_handoffs() {
        let tmp = tempfile::tempdir().unwrap();
        let maps = KernelMaps::open(tmp.path().to_path_buf());
        let id = "hermes:20260420_134853_5501ee";
        maps.update(
            id,
            upd(json!({"handoffs": [
            {"who": "operator", "type": "ops", "action": "Pinned row", "pinned": true},
            {"who": "operator", "type": "ops", "action": "Old row", "n": 1}]})),
        )
        .unwrap();
        let reply =
            "Shipped.\n\n| \\ | Who | Type | Action | Why |\n| --- | --- | --- | --- | --- |\n\
            | \\1 | 🙋🏻‍♂️ operator | ✍️ [SignOff] | Approve the release | |\n";
        let m = maps.update(id, upd(json!({"reply": reply}))).unwrap();
        let actions: Vec<&str> = m.handoffs.iter().map(|h| h.action.as_str()).collect();
        assert_eq!(actions, ["Pinned row", "Approve the release"]);
        // A reply without a table leaves the hand-offs alone.
        let m = maps
            .update(id, upd(json!({"reply": "Still working."})))
            .unwrap();
        assert_eq!(m.handoffs.len(), 2);
    }

    #[test]
    fn rejects_invalid_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let maps = KernelMaps::open(tmp.path().to_path_buf());
        let id = "pi:019a0b7c-1d2e-7f30-8a41-5b6c7d8e9f01";
        assert!(maps.update(id, upd(json!({"status": "sleeping"}))).is_err());
        assert!(maps
            .update(
                id,
                upd(json!({"steps": [{"text": "x", "status": "maybe"}]}))
            )
            .is_err());
        assert!(maps
            .update(
                id,
                upd(json!({"handoffs": [{"who": "o", "type": "chat", "action": "x"}]}))
            )
            .is_err());
        assert!(maps.update("nope:x", upd(json!({"goal": "x"}))).is_err());
        assert!(maps.all().is_empty());
    }
}
