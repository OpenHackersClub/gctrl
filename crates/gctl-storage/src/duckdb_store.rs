use std::path::Path;
use std::sync::Mutex;

use duckdb::{params, Connection};
use gctl_core::{
    AgentAnalytics, AlertEvent, AlertRule, Analytics, DailyAggregate, GctlError, ModelAnalytics,
    PromptVersion, Result, Score, Session, SessionId, SessionStatus, Span, SpanStatus, SpanType, Tag,
    TrafficFilter, TrafficRecord, TrafficStats,
};

use crate::schema;

pub struct DuckDbStore {
    conn: Mutex<Connection>,
}

impl DuckDbStore {
    /// Open (or create) a DuckDB database at the given path.
    /// Pass `:memory:` for an in-memory database (useful for tests).
    pub fn open(path: &str) -> Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()
        } else {
            if let Some(parent) = Path::new(path).parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| GctlError::Storage(format!("create dir: {e}")))?;
            }
            Connection::open(path)
        }
        .map_err(|e| GctlError::Storage(e.to_string()))?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.run_migrations()?;
        Ok(store)
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for stmt in schema::all_migrations() {
            conn.execute_batch(stmt)
                .map_err(|e| GctlError::Storage(format!("migration: {e}")))?;
        }
        Ok(())
    }

    pub fn insert_session(&self, session: &Session) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, workspace_id, device_id, agent_name, started_at, ended_at, status, total_cost_usd, total_input_tokens, total_output_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                session.id.0,
                session.workspace_id.0,
                session.device_id.0,
                session.agent_name,
                session.started_at.to_rfc3339(),
                session.ended_at.map(|t| t.to_rfc3339()),
                session.status.as_str(),
                session.total_cost_usd,
                session.total_input_tokens as i64,
                session.total_output_tokens as i64,
            ],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn insert_span(&self, span: &Span) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO spans (span_id, trace_id, parent_span_id, session_id, agent_name, operation_name, span_type, model, input_tokens, output_tokens, cost_usd, status, error_message, started_at, duration_ms, attributes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                span.span_id.0,
                span.trace_id.0,
                span.parent_span_id.as_ref().map(|s| &s.0),
                span.session_id.0,
                span.agent_name,
                span.operation_name,
                span.span_type.as_str(),
                span.model,
                span.input_tokens as i64,
                span.output_tokens as i64,
                span.cost_usd,
                span.status.as_str(),
                span.status.error_message(),
                span.started_at.to_rfc3339(),
                span.duration_ms as i64,
                span.attributes.to_string(),
            ],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn insert_spans(&self, spans: &[Span]) -> Result<()> {
        for span in spans {
            self.insert_span(span)?;
        }
        // Update session aggregates for affected sessions
        let mut session_ids = std::collections::HashSet::new();
        for span in spans {
            session_ids.insert(span.session_id.0.clone());
        }
        for sid in session_ids {
            self.update_session_aggregates(&sid)?;
        }
        Ok(())
    }

    fn update_session_aggregates(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET
                total_cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM spans WHERE session_id = ?1),
                total_input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM spans WHERE session_id = ?1),
                total_output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM spans WHERE session_id = ?1)
             WHERE id = ?1",
            params![session_id],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_session(&self, id: &SessionId) -> Result<Option<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, workspace_id, device_id, agent_name, started_at, ended_at, status, total_cost_usd, total_input_tokens, total_output_tokens FROM sessions WHERE id = ?")
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut rows = stmt
            .query(params![id.0])
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        if let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            Ok(Some(row_to_session(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_sessions(&self, limit: usize) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, workspace_id, device_id, agent_name, started_at, ended_at, status, total_cost_usd, total_input_tokens, total_output_tokens FROM sessions ORDER BY started_at DESC LIMIT ?")
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut rows = stmt
            .query(params![limit as i64])
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut sessions = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            sessions.push(row_to_session(row)?);
        }
        Ok(sessions)
    }

    pub fn query_spans(&self, session_id: &SessionId) -> Result<Vec<Span>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT span_id, trace_id, parent_span_id, session_id, agent_name, operation_name, span_type, model, input_tokens, output_tokens, cost_usd, status, error_message, started_at, duration_ms, attributes FROM spans WHERE session_id = ? ORDER BY started_at ASC")
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut rows = stmt
            .query(params![session_id.0])
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut spans = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            spans.push(row_to_span(row)?);
        }
        Ok(spans)
    }

    pub fn insert_traffic(&self, record: &TrafficRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO traffic (id, timestamp, method, url, host, status_code, request_size, response_size, duration_ms, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                record.id,
                record.timestamp.to_rfc3339(),
                record.method,
                record.url,
                record.host,
                record.status_code as i32,
                record.request_size_bytes as i64,
                record.response_size_bytes as i64,
                record.duration_ms as i64,
                record.session_id.as_ref().map(|s| &s.0),
            ],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn query_traffic(&self, filter: &TrafficFilter) -> Result<Vec<TrafficRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = "SELECT id, timestamp, method, url, host, status_code, request_size, response_size, duration_ms, session_id FROM traffic WHERE 1=1".to_string();
        if filter.host.is_some() {
            sql.push_str(" AND host = ?");
        }
        if filter.since.is_some() {
            sql.push_str(" AND timestamp >= ?");
        }
        sql.push_str(" ORDER BY timestamp DESC");
        let limit = filter.limit.unwrap_or(50);
        sql.push_str(&format!(" LIMIT {limit}"));

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut param_idx = 1;
        let mut bound_params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        if let Some(ref host) = filter.host {
            bound_params.push(Box::new(host.clone()));
            param_idx += 1;
        }
        if let Some(ref since) = filter.since {
            bound_params.push(Box::new(since.to_rfc3339()));
            let _ = param_idx;
        }

        let params_refs: Vec<&dyn duckdb::ToSql> = bound_params.iter().map(|p| p.as_ref()).collect();
        let mut rows = stmt
            .query(params_refs.as_slice())
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut records = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            records.push(row_to_traffic(row)?);
        }
        Ok(records)
    }

    pub fn get_traffic_stats(&self) -> Result<TrafficStats> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM traffic", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(TrafficStats {
            total_requests: total as u64,
            ..Default::default()
        })
    }

    pub fn get_analytics(&self) -> Result<Analytics> {
        let conn = self.conn.lock().unwrap();

        let total_sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let total_spans: i64 = conn
            .query_row("SELECT COUNT(*) FROM spans", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let total_cost: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions",
                [],
                |row| row.get(0),
            )
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let total_input: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(total_input_tokens), 0) FROM sessions",
                [],
                |row| row.get(0),
            )
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        let total_output: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(total_output_tokens), 0) FROM sessions",
                [],
                |row| row.get(0),
            )
            .map_err(|e| GctlError::Storage(e.to_string()))?;

        // By agent
        let mut by_agent = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT agent_name, COUNT(*), COALESCE(SUM(total_cost_usd), 0) FROM sessions GROUP BY agent_name ORDER BY SUM(total_cost_usd) DESC")
                .map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let agent_name: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
                let count: i64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
                let cost: f64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
                by_agent.push(AgentAnalytics {
                    agent_name,
                    session_count: count as u64,
                    total_cost_usd: cost,
                });
            }
        }

        // By model
        let mut by_model = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT model, COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0) FROM spans WHERE model IS NOT NULL GROUP BY model ORDER BY SUM(cost_usd) DESC")
                .map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let model: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
                let count: i64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
                let input: i64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
                let output: i64 = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
                let cost: f64 = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
                by_model.push(ModelAnalytics {
                    model,
                    span_count: count as u64,
                    total_input_tokens: input as u64,
                    total_output_tokens: output as u64,
                    total_cost_usd: cost,
                });
            }
        }

        Ok(Analytics {
            total_sessions: total_sessions as u64,
            total_spans: total_spans as u64,
            total_cost_usd: total_cost,
            total_input_tokens: total_input as u64,
            total_output_tokens: total_output as u64,
            by_agent,
            by_model,
        })
    }

    // --- Scores ---
    pub fn insert_score(&self, score: &Score) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO scores (id, target_type, target_id, name, value, comment, source, scored_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![score.id, score.target_type, score.target_id, score.name, score.value, score.comment, score.source, score.scored_by, score.created_at.to_rfc3339()],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_scores(&self, target_type: &str, target_id: &str) -> Result<Vec<Score>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, target_type, target_id, name, value, comment, source, scored_by, created_at FROM scores WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query(params![target_type, target_id]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut scores = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            scores.push(row_to_score(row)?);
        }
        Ok(scores)
    }

    pub fn get_score_summary(&self, name: &str) -> Result<(u64, u64, f64)> {
        // Returns (pass_count, fail_count, avg_value)
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM scores WHERE name = ?", params![name], |row| row.get(0)
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let pass: i64 = conn.query_row(
            "SELECT COUNT(*) FROM scores WHERE name = ? AND value >= 1.0", params![name], |row| row.get(0)
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let avg: f64 = conn.query_row(
            "SELECT COALESCE(AVG(value), 0) FROM scores WHERE name = ?", params![name], |row| row.get(0)
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok((pass as u64, (total - pass) as u64, avg))
    }

    pub fn auto_score_session(&self, session_id: &str) -> Result<Vec<Score>> {
        let spans = self.query_spans(&SessionId(session_id.into()))?;
        let mut scores = Vec::new();

        // Score: span_count
        scores.push(Score {
            id: format!("auto-{session_id}-span_count"),
            target_type: "session".into(),
            target_id: session_id.into(),
            name: "span_count".into(),
            value: spans.len() as f64,
            comment: None,
            source: "auto".into(),
            scored_by: None,
            created_at: chrono::Utc::now(),
        });

        // Score: error_count
        let error_count = spans.iter().filter(|s| matches!(s.status, SpanStatus::Error(_))).count();
        scores.push(Score {
            id: format!("auto-{session_id}-error_count"),
            target_type: "session".into(),
            target_id: session_id.into(),
            name: "error_count".into(),
            value: error_count as f64,
            comment: None,
            source: "auto".into(),
            scored_by: None,
            created_at: chrono::Utc::now(),
        });

        // Score: generation_count
        let gen_count = spans.iter().filter(|s| s.span_type == SpanType::Generation).count();
        scores.push(Score {
            id: format!("auto-{session_id}-generation_count"),
            target_type: "session".into(),
            target_id: session_id.into(),
            name: "generation_count".into(),
            value: gen_count as f64,
            comment: None,
            source: "auto".into(),
            scored_by: None,
            created_at: chrono::Utc::now(),
        });

        // Score: cost_efficiency (cost per generation, or 0 if no generations)
        let session = self.get_session(&SessionId(session_id.into()))?;
        if let Some(session) = session {
            if gen_count > 0 {
                scores.push(Score {
                    id: format!("auto-{session_id}-cost_per_gen"),
                    target_type: "session".into(),
                    target_id: session_id.into(),
                    name: "cost_per_generation".into(),
                    value: session.total_cost_usd / gen_count as f64,
                    comment: None,
                    source: "auto".into(),
                    scored_by: None,
                    created_at: chrono::Utc::now(),
                });
            }
        }

        for score in &scores {
            self.insert_score(score)?;
        }

        Ok(scores)
    }

    // --- Tags ---
    pub fn insert_tag(&self, tag: &Tag) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO tags (id, target_type, target_id, key, value) VALUES (?, ?, ?, ?, ?)",
            params![tag.id, tag.target_type, tag.target_id, tag.key, tag.value],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_tags(&self, target_type: &str, target_id: &str) -> Result<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, target_type, target_id, key, value FROM tags WHERE target_type = ? AND target_id = ?"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query(params![target_type, target_id]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut tags = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let tt: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let ti: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            let k: String = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
            let v: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
            tags.push(Tag { id, target_type: tt, target_id: ti, key: k, value: v });
        }
        Ok(tags)
    }

    // --- Prompt Versions ---
    pub fn insert_prompt_version(&self, pv: &PromptVersion) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO prompt_versions (hash, content, file_path, label, created_at, token_count) VALUES (?, ?, ?, ?, ?, ?)",
            params![pv.hash, pv.content, pv.file_path, pv.label, pv.created_at.to_rfc3339(), pv.token_count],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn link_session_prompt(&self, session_id: &str, prompt_hash: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO session_prompts (session_id, prompt_hash) VALUES (?, ?)",
            params![session_id, prompt_hash],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_prompt_version(&self, hash: &str) -> Result<Option<PromptVersion>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hash, content, file_path, label, created_at, token_count FROM prompt_versions WHERE hash = ?"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query(params![hash]).map_err(|e| GctlError::Storage(e.to_string()))?;
        if let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            Ok(Some(row_to_prompt_version(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_prompt_versions(&self) -> Result<Vec<PromptVersion>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hash, content, file_path, label, created_at, token_count FROM prompt_versions ORDER BY created_at DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut pvs = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            pvs.push(row_to_prompt_version(row)?);
        }
        Ok(pvs)
    }

    // --- Daily Aggregates ---
    pub fn upsert_daily_aggregate(&self, agg: &DailyAggregate) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO daily_aggregates (date, metric, dimension, value) VALUES (?, ?, ?, ?)",
            params![agg.date, agg.metric, agg.dimension, agg.value],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_daily_aggregates(&self, days: u32) -> Result<Vec<DailyAggregate>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT date, metric, dimension, value FROM daily_aggregates ORDER BY date DESC LIMIT ?"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query(params![(days * 10) as i64]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut aggs = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let date: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let metric: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let dimension: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            let value: f64 = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
            aggs.push(DailyAggregate { date, metric, dimension, value });
        }
        Ok(aggs)
    }

    // --- Alert Rules ---
    pub fn insert_alert_rule(&self, rule: &AlertRule) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO alert_rules (id, name, condition_type, threshold, action, enabled) VALUES (?, ?, ?, ?, ?, ?)",
            params![rule.id, rule.name, rule.condition_type, rule.threshold, rule.action, rule.enabled],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn list_alert_rules(&self) -> Result<Vec<AlertRule>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, condition_type, threshold, action, enabled FROM alert_rules WHERE enabled = TRUE"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rules = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let name: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let ct: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            let threshold: f64 = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
            let action: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
            let enabled: bool = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
            rules.push(AlertRule { id, name, condition_type: ct, threshold, action, enabled });
        }
        Ok(rules)
    }

    pub fn insert_alert_event(&self, event: &AlertEvent) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO alert_events (id, rule_id, session_id, timestamp, message, acknowledged) VALUES (?, ?, ?, ?, ?, ?)",
            params![event.id, event.rule_id, event.session_id, event.timestamp.to_rfc3339(), event.message, event.acknowledged],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    // --- Cost Analytics ---
    pub fn get_cost_by_model(&self) -> Result<Vec<(String, f64, u64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT model, COALESCE(SUM(cost_usd), 0), COUNT(*) FROM spans WHERE model IS NOT NULL GROUP BY model ORDER BY SUM(cost_usd) DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let model: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let cost: f64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let count: i64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            results.push((model, cost, count as u64));
        }
        Ok(results)
    }

    pub fn get_cost_by_agent(&self) -> Result<Vec<(String, f64, u64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT agent_name, COALESCE(SUM(total_cost_usd), 0), COUNT(*) FROM sessions GROUP BY agent_name ORDER BY SUM(total_cost_usd) DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let agent: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let cost: f64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let count: i64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            results.push((agent, cost, count as u64));
        }
        Ok(results)
    }

    // --- Latency Analytics ---
    pub fn get_latency_by_model(&self) -> Result<Vec<(String, f64, f64, f64)>> {
        // Returns (model, p50_ms, p95_ms, p99_ms)
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT model, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms), PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) FROM spans WHERE model IS NOT NULL GROUP BY model"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let model: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let p50: f64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let p95: f64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            let p99: f64 = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
            results.push((model, p50, p95, p99));
        }
        Ok(results)
    }
}

fn row_to_session(row: &duckdb::Row<'_>) -> Result<Session> {
    let id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
    let workspace_id: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
    let device_id: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
    let agent_name: String = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
    let started_at: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
    let ended_at: Option<String> = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
    let status: String = row.get(6).map_err(|e| GctlError::Storage(e.to_string()))?;
    let total_cost_usd: f64 = row.get(7).map_err(|e| GctlError::Storage(e.to_string()))?;
    let total_input_tokens: i64 = row.get(8).map_err(|e| GctlError::Storage(e.to_string()))?;
    let total_output_tokens: i64 = row.get(9).map_err(|e| GctlError::Storage(e.to_string()))?;

    Ok(Session {
        id: gctl_core::SessionId(id),
        workspace_id: gctl_core::WorkspaceId(workspace_id),
        device_id: gctl_core::DeviceId(device_id),
        agent_name,
        started_at: chrono::DateTime::parse_from_rfc3339(&started_at)
            .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))?
            .with_timezone(&chrono::Utc),
        ended_at: ended_at
            .map(|t| {
                chrono::DateTime::parse_from_rfc3339(&t)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))
            })
            .transpose()?,
        status: SessionStatus::from_str(&status).unwrap_or(SessionStatus::Active),
        total_cost_usd,
        total_input_tokens: total_input_tokens as u64,
        total_output_tokens: total_output_tokens as u64,
    })
}

fn row_to_span(row: &duckdb::Row<'_>) -> Result<Span> {
    let span_id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
    let trace_id: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
    let parent_span_id: Option<String> = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
    let session_id: String = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
    let agent_name: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
    let operation_name: String = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
    let span_type_str: String = row.get(6).map_err(|e| GctlError::Storage(e.to_string()))?;
    let model: Option<String> = row.get(7).map_err(|e| GctlError::Storage(e.to_string()))?;
    let input_tokens: i64 = row.get(8).map_err(|e| GctlError::Storage(e.to_string()))?;
    let output_tokens: i64 = row.get(9).map_err(|e| GctlError::Storage(e.to_string()))?;
    let cost_usd: f64 = row.get(10).map_err(|e| GctlError::Storage(e.to_string()))?;
    let status: String = row.get(11).map_err(|e| GctlError::Storage(e.to_string()))?;
    let error_message: Option<String> = row.get(12).map_err(|e| GctlError::Storage(e.to_string()))?;
    let started_at: String = row.get(13).map_err(|e| GctlError::Storage(e.to_string()))?;
    let duration_ms: i64 = row.get(14).map_err(|e| GctlError::Storage(e.to_string()))?;
    let attributes: String = row.get(15).map_err(|e| GctlError::Storage(e.to_string()))?;

    let span_status = match status.as_str() {
        "ok" => SpanStatus::Ok,
        "error" => SpanStatus::Error(error_message.unwrap_or_default()),
        _ => SpanStatus::Unset,
    };

    Ok(Span {
        span_id: gctl_core::SpanId(span_id),
        trace_id: gctl_core::TraceId(trace_id),
        parent_span_id: parent_span_id.map(gctl_core::SpanId),
        session_id: gctl_core::SessionId(session_id),
        agent_name,
        operation_name,
        span_type: gctl_core::SpanType::from_str(&span_type_str),
        model,
        input_tokens: input_tokens as u64,
        output_tokens: output_tokens as u64,
        cost_usd,
        status: span_status,
        started_at: chrono::DateTime::parse_from_rfc3339(&started_at)
            .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))?
            .with_timezone(&chrono::Utc),
        duration_ms: duration_ms as u64,
        attributes: serde_json::from_str(&attributes).unwrap_or(serde_json::Value::Null),
    })
}

fn row_to_traffic(row: &duckdb::Row<'_>) -> Result<TrafficRecord> {
    let id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
    let timestamp: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
    let method: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
    let url: String = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
    let host: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
    let status_code: i32 = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
    let request_size: i64 = row.get(6).map_err(|e| GctlError::Storage(e.to_string()))?;
    let response_size: i64 = row.get(7).map_err(|e| GctlError::Storage(e.to_string()))?;
    let duration_ms: i64 = row.get(8).map_err(|e| GctlError::Storage(e.to_string()))?;
    let session_id: Option<String> = row.get(9).map_err(|e| GctlError::Storage(e.to_string()))?;

    Ok(TrafficRecord {
        id,
        timestamp: chrono::DateTime::parse_from_rfc3339(&timestamp)
            .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))?
            .with_timezone(&chrono::Utc),
        method,
        url,
        host,
        status_code: status_code as u16,
        request_size_bytes: request_size as u64,
        response_size_bytes: response_size as u64,
        duration_ms: duration_ms as u64,
        session_id: session_id.map(gctl_core::SessionId),
    })
}

fn row_to_score(row: &duckdb::Row<'_>) -> Result<Score> {
    let id: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
    let target_type: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
    let target_id: String = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
    let name: String = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
    let value: f64 = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
    let comment: Option<String> = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
    let source: String = row.get(6).map_err(|e| GctlError::Storage(e.to_string()))?;
    let scored_by: Option<String> = row.get(7).map_err(|e| GctlError::Storage(e.to_string()))?;
    let created_at: String = row.get(8).map_err(|e| GctlError::Storage(e.to_string()))?;
    Ok(Score {
        id, target_type, target_id, name, value, comment, source, scored_by,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))?
            .with_timezone(&chrono::Utc),
    })
}

fn row_to_prompt_version(row: &duckdb::Row<'_>) -> Result<PromptVersion> {
    let hash: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
    let content: String = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
    let file_path: Option<String> = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
    let label: Option<String> = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
    let created_at: String = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
    let token_count: Option<i32> = row.get(5).map_err(|e| GctlError::Storage(e.to_string()))?;
    Ok(PromptVersion {
        hash, content, file_path, label,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .map_err(|e| GctlError::Storage(format!("parse timestamp: {e}")))?
            .with_timezone(&chrono::Utc),
        token_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctl_core::*;

    fn test_store() -> DuckDbStore {
        DuckDbStore::open(":memory:").unwrap()
    }

    fn make_session(id: &str) -> Session {
        Session {
            id: SessionId(id.into()),
            workspace_id: WorkspaceId("ws1".into()),
            device_id: DeviceId("dev1".into()),
            agent_name: "claude".into(),
            started_at: Utc::now(),
            ended_at: None,
            status: SessionStatus::Active,
            total_cost_usd: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
        }
    }

    fn make_span(span_id: &str, session_id: &str) -> Span {
        Span {
            span_id: SpanId(span_id.into()),
            trace_id: TraceId("trace1".into()),
            parent_span_id: None,
            session_id: SessionId(session_id.into()),
            agent_name: "claude".into(),
            operation_name: "llm.call".into(),
            span_type: SpanType::Generation,
            model: Some("claude-opus-4-6".into()),
            input_tokens: 1000,
            output_tokens: 500,
            cost_usd: 0.05,
            status: SpanStatus::Ok,
            started_at: Utc::now(),
            duration_ms: 2000,
            attributes: serde_json::json!({}),
        }
    }

    #[test]
    fn test_session_roundtrip() {
        let store = test_store();
        let session = make_session("s1");
        store.insert_session(&session).unwrap();

        let retrieved = store.get_session(&SessionId("s1".into())).unwrap();
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.id.0, "s1");
        assert_eq!(retrieved.agent_name, "claude");
    }

    #[test]
    fn test_session_not_found() {
        let store = test_store();
        let result = store.get_session(&SessionId("nonexistent".into())).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_list_sessions() {
        let store = test_store();
        for i in 0..5 {
            store.insert_session(&make_session(&format!("s{i}"))).unwrap();
        }
        let sessions = store.list_sessions(3).unwrap();
        assert_eq!(sessions.len(), 3);
    }

    #[test]
    fn test_span_insert_and_query() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let span = make_span("sp1", "s1");
        store.insert_span(&span).unwrap();

        let spans = store.query_spans(&SessionId("s1".into())).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].span_id.0, "sp1");
        assert_eq!(spans[0].input_tokens, 1000);
        assert_eq!(spans[0].cost_usd, 0.05);
    }

    #[test]
    fn test_insert_multiple_spans() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let spans: Vec<Span> = (0..3).map(|i| make_span(&format!("sp{i}"), "s1")).collect();
        store.insert_spans(&spans).unwrap();

        let result = store.query_spans(&SessionId("s1".into())).unwrap();
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_span_with_error_status() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let mut span = make_span("sp_err", "s1");
        span.status = SpanStatus::Error("timeout".into());
        store.insert_span(&span).unwrap();

        let spans = store.query_spans(&SessionId("s1".into())).unwrap();
        assert_eq!(spans.len(), 1);
        match &spans[0].status {
            SpanStatus::Error(msg) => assert_eq!(msg, "timeout"),
            _ => panic!("expected error status"),
        }
    }

    #[test]
    fn test_traffic_insert_and_query() {
        let store = test_store();
        let record = TrafficRecord {
            id: "t1".into(),
            timestamp: Utc::now(),
            method: "POST".into(),
            url: "https://api.anthropic.com/v1/messages".into(),
            host: "api.anthropic.com".into(),
            status_code: 200,
            request_size_bytes: 1024,
            response_size_bytes: 4096,
            duration_ms: 500,
            session_id: None,
        };
        store.insert_traffic(&record).unwrap();

        let records = store.query_traffic(&TrafficFilter::default()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].host, "api.anthropic.com");
    }

    #[test]
    fn test_analytics_empty() {
        let store = test_store();
        let analytics = store.get_analytics().unwrap();
        assert_eq!(analytics.total_sessions, 0);
        assert_eq!(analytics.total_spans, 0);
        assert!(analytics.by_agent.is_empty());
        assert!(analytics.by_model.is_empty());
    }

    #[test]
    fn test_session_aggregation_on_insert_spans() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let spans: Vec<Span> = (0..3).map(|i| make_span(&format!("sp{i}"), "s1")).collect();
        store.insert_spans(&spans).unwrap();

        // Session should now have aggregated totals
        let session = store.get_session(&SessionId("s1".into())).unwrap().unwrap();
        assert_eq!(session.total_input_tokens, 3000);  // 3 * 1000
        assert_eq!(session.total_output_tokens, 1500); // 3 * 500
        assert!((session.total_cost_usd - 0.15).abs() < 0.001); // 3 * 0.05
    }

    #[test]
    fn test_analytics_by_agent_and_model() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let spans: Vec<Span> = (0..2).map(|i| make_span(&format!("sp{i}"), "s1")).collect();
        store.insert_spans(&spans).unwrap();

        let analytics = store.get_analytics().unwrap();
        assert_eq!(analytics.total_sessions, 1);
        assert_eq!(analytics.total_spans, 2);
        assert!((analytics.total_cost_usd - 0.10).abs() < 0.001);
        assert_eq!(analytics.total_input_tokens, 2000);
        assert_eq!(analytics.total_output_tokens, 1000);

        // by_agent
        assert_eq!(analytics.by_agent.len(), 1);
        assert_eq!(analytics.by_agent[0].agent_name, "claude");
        assert_eq!(analytics.by_agent[0].session_count, 1);

        // by_model
        assert_eq!(analytics.by_model.len(), 1);
        assert_eq!(analytics.by_model[0].model, "claude-opus-4-6");
        assert_eq!(analytics.by_model[0].span_count, 2);
    }

    #[test]
    fn test_score_insert_and_query() {
        let store = test_store();
        let score = Score {
            id: "score1".into(),
            target_type: "session".into(),
            target_id: "s1".into(),
            name: "quality".into(),
            value: 4.0,
            comment: Some("Good work".into()),
            source: "human".into(),
            scored_by: Some("alice".into()),
            created_at: Utc::now(),
        };
        store.insert_score(&score).unwrap();
        let scores = store.get_scores("session", "s1").unwrap();
        assert_eq!(scores.len(), 1);
        assert_eq!(scores[0].name, "quality");
        assert!((scores[0].value - 4.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_score_summary() {
        let store = test_store();
        for i in 0..5 {
            let score = Score {
                id: format!("score{i}"),
                target_type: "session".into(),
                target_id: format!("s{i}"),
                name: "tests_pass".into(),
                value: if i < 4 { 1.0 } else { 0.0 },
                comment: None,
                source: "auto".into(),
                scored_by: None,
                created_at: Utc::now(),
            };
            store.insert_score(&score).unwrap();
        }
        let (pass, fail, avg) = store.get_score_summary("tests_pass").unwrap();
        assert_eq!(pass, 4);
        assert_eq!(fail, 1);
        assert!((avg - 0.8).abs() < 0.01);
    }

    #[test]
    fn test_tag_insert_and_query() {
        let store = test_store();
        let tag = Tag {
            id: "tag1".into(),
            target_type: "session".into(),
            target_id: "s1".into(),
            key: "project".into(),
            value: "api-server".into(),
        };
        store.insert_tag(&tag).unwrap();
        let tags = store.get_tags("session", "s1").unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].key, "project");
        assert_eq!(tags[0].value, "api-server");
    }

    #[test]
    fn test_prompt_version_roundtrip() {
        let store = test_store();
        let pv = PromptVersion {
            hash: "abc123".into(),
            content: "You are a helpful assistant.".into(),
            file_path: Some("CLAUDE.md".into()),
            label: Some("v2.3".into()),
            created_at: Utc::now(),
            token_count: Some(42),
        };
        store.insert_prompt_version(&pv).unwrap();
        let retrieved = store.get_prompt_version("abc123").unwrap();
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.hash, "abc123");
        assert_eq!(retrieved.token_count, Some(42));
    }

    #[test]
    fn test_prompt_version_not_found() {
        let store = test_store();
        assert!(store.get_prompt_version("nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_daily_aggregates() {
        let store = test_store();
        let agg = DailyAggregate {
            date: "2026-03-22".into(),
            metric: "cost".into(),
            dimension: "total".into(),
            value: 42.18,
        };
        store.upsert_daily_aggregate(&agg).unwrap();
        let aggs = store.get_daily_aggregates(7).unwrap();
        assert_eq!(aggs.len(), 1);
        assert_eq!(aggs[0].date, "2026-03-22");
        assert!((aggs[0].value - 42.18).abs() < f64::EPSILON);
    }

    #[test]
    fn test_alert_rules() {
        let store = test_store();
        let rule = AlertRule {
            id: "rule1".into(),
            name: "budget-breach".into(),
            condition_type: "session_cost".into(),
            threshold: 5.0,
            action: "warn".into(),
            enabled: true,
        };
        store.insert_alert_rule(&rule).unwrap();
        let rules = store.list_alert_rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "budget-breach");
    }

    #[test]
    fn test_cost_by_model() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.insert_spans(&[make_span("sp1", "s1"), make_span("sp2", "s1")]).unwrap();
        let costs = store.get_cost_by_model().unwrap();
        assert_eq!(costs.len(), 1);
        assert_eq!(costs[0].0, "claude-opus-4-6");
        assert!((costs[0].1 - 0.10).abs() < 0.001);  // 2 * 0.05
        assert_eq!(costs[0].2, 2);
    }

    #[test]
    fn test_cost_by_agent() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.insert_spans(&[make_span("sp1", "s1")]).unwrap();
        let costs = store.get_cost_by_agent().unwrap();
        assert_eq!(costs.len(), 1);
        assert_eq!(costs[0].0, "claude");
    }

    #[test]
    fn test_latency_by_model() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.insert_spans(&[make_span("sp1", "s1"), make_span("sp2", "s1")]).unwrap();
        let latencies = store.get_latency_by_model().unwrap();
        assert_eq!(latencies.len(), 1);
        assert_eq!(latencies[0].0, "claude-opus-4-6");
    }

    #[test]
    fn test_auto_score_session() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.insert_spans(&[make_span("sp1", "s1"), make_span("sp2", "s1")]).unwrap();

        let scores = store.auto_score_session("s1").unwrap();
        assert!(scores.len() >= 3);

        // Check span_count
        let span_count = scores.iter().find(|s| s.name == "span_count").unwrap();
        assert!((span_count.value - 2.0).abs() < f64::EPSILON);

        // Check generation_count
        let gen_count = scores.iter().find(|s| s.name == "generation_count").unwrap();
        assert!((gen_count.value - 2.0).abs() < f64::EPSILON);  // make_span creates Generation type
    }
}
