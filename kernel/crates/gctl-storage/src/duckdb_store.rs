use std::path::Path;
use std::sync::Mutex;

use duckdb::{params, Connection};
use gctl_core::{
    AgentAnalytics, AlertEvent, AlertRule, Analytics, DailyAggregate, GctlError, ModelAnalytics,
    InboxAction, InboxActionFilter, InboxMessage, InboxMessageFilter, InboxThread,
    PersonaDefinition, PersonaReviewRule,
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

    pub fn end_session(&self, session_id: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?",
            params![status, chrono::Utc::now().to_rfc3339(), session_id],
        )
        .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Detect error loops: sequences of N identical consecutive operations.
    pub fn detect_error_loops(&self, session_id: &str, threshold: usize) -> Result<Vec<String>> {
        let spans = self.query_spans(&SessionId(session_id.into()))?;
        let ops: Vec<&str> = spans.iter().map(|s| s.operation_name.as_str()).collect();

        let mut loops = Vec::new();
        if ops.len() < threshold {
            return Ok(loops);
        }

        let mut i = 0;
        while i + threshold <= ops.len() {
            let window = &ops[i..i + threshold];
            if window.iter().all(|op| *op == window[0]) {
                let msg = format!(
                    "{} consecutive '{}' calls at position {}",
                    threshold, window[0], i
                );
                if !loops.contains(&msg) {
                    loops.push(msg);
                }
            }
            i += 1;
        }
        Ok(loops)
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

    pub fn list_sessions_filtered(&self, limit: usize, agent: Option<&str>, status: Option<&str>) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = "SELECT id, workspace_id, device_id, agent_name, started_at, ended_at, status, total_cost_usd, total_input_tokens, total_output_tokens FROM sessions WHERE 1=1".to_string();
        let mut bound_params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();

        if let Some(agent_name) = agent {
            sql.push_str(" AND agent_name = ?");
            bound_params.push(Box::new(agent_name.to_string()));
        }
        if let Some(status_val) = status {
            sql.push_str(" AND status = ?");
            bound_params.push(Box::new(status_val.to_string()));
        }
        sql.push_str(" ORDER BY started_at DESC");
        sql.push_str(&format!(" LIMIT {}", limit));

        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let params_refs: Vec<&dyn duckdb::ToSql> = bound_params.iter().map(|p| p.as_ref()).collect();
        let mut rows = stmt.query(params_refs.as_slice()).map_err(|e| GctlError::Storage(e.to_string()))?;

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

    /// Compute and store daily aggregates for today from sessions/spans.
    pub fn compute_daily_aggregates(&self, date: &str) -> Result<Vec<DailyAggregate>> {
        let conn = self.conn.lock().unwrap();
        let mut aggs = Vec::new();

        // Total cost for the day
        let cost: f64 = conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions WHERE started_at LIKE ?",
            params![format!("{date}%")],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        aggs.push(DailyAggregate { date: date.into(), metric: "cost".into(), dimension: "total".into(), value: cost });

        // Session count
        let sessions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE started_at LIKE ?",
            params![format!("{date}%")],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        aggs.push(DailyAggregate { date: date.into(), metric: "sessions".into(), dimension: "total".into(), value: sessions as f64 });

        // Total tokens
        let tokens: i64 = conn.query_row(
            "SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) FROM sessions WHERE started_at LIKE ?",
            params![format!("{date}%")],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        aggs.push(DailyAggregate { date: date.into(), metric: "tokens".into(), dimension: "total".into(), value: tokens as f64 });

        // Span count
        let spans: i64 = conn.query_row(
            "SELECT COUNT(*) FROM spans WHERE started_at LIKE ?",
            params![format!("{date}%")],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        aggs.push(DailyAggregate { date: date.into(), metric: "spans".into(), dimension: "total".into(), value: spans as f64 });

        drop(conn);

        for agg in &aggs {
            self.upsert_daily_aggregate(agg)?;
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

    /// Get per-model cost breakdown for a specific session.
    pub fn get_session_cost_breakdown(&self, session_id: &str) -> Result<Vec<(String, f64, u64, u64, u64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT COALESCE(model, 'unknown'), COALESCE(SUM(cost_usd), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COUNT(*) FROM spans WHERE session_id = ? GROUP BY model ORDER BY SUM(cost_usd) DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query(params![session_id]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let model: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let cost: f64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let input: i64 = row.get(2).map_err(|e| GctlError::Storage(e.to_string()))?;
            let output: i64 = row.get(3).map_err(|e| GctlError::Storage(e.to_string()))?;
            let count: i64 = row.get(4).map_err(|e| GctlError::Storage(e.to_string()))?;
            results.push((model, cost, input as u64, output as u64, count as u64));
        }
        Ok(results)
    }

    /// Get span type distribution: count of Generation, Span, Event types.
    pub fn get_span_type_distribution(&self) -> Result<Vec<(String, u64, f64)>> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM spans", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        if total == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(
            "SELECT span_type, COUNT(*) FROM spans GROUP BY span_type ORDER BY COUNT(*) DESC"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let span_type: String = row.get(0).map_err(|e| GctlError::Storage(e.to_string()))?;
            let count: i64 = row.get(1).map_err(|e| GctlError::Storage(e.to_string()))?;
            let pct = count as f64 / total as f64 * 100.0;
            results.push((span_type, count as u64, pct));
        }
        Ok(results)
    }

    /// Return table counts for health endpoint.
    pub fn get_health_info(&self) -> Result<serde_json::Value> {
        let conn = self.conn.lock().unwrap();
        let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let spans: i64 = conn.query_row("SELECT COUNT(*) FROM spans", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let traffic: i64 = conn.query_row("SELECT COUNT(*) FROM traffic", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let alerts: i64 = conn.query_row("SELECT COUNT(*) FROM alert_rules WHERE enabled = TRUE", [], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(serde_json::json!({
            "sessions": sessions,
            "spans": spans,
            "traffic_records": traffic,
            "active_alert_rules": alerts,
        }))
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

    // ═══════════════════════════════════════════════════════════════
    // Board Application — Projects, Issues, Events, Comments
    // ═══════════════════════════════════════════════════════════════

    pub fn create_board_project(&self, project: &gctl_core::BoardProject) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_projects (id, name, key, counter, github_repo) VALUES (?, ?, ?, ?, ?)",
            params![project.id, project.name, project.key, project.counter, project.github_repo],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn get_board_project(&self, id: &str) -> Result<Option<gctl_core::BoardProject>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, key, counter, github_repo FROM board_projects WHERE id = ?1",
            [id],
            |row| {
                Ok(gctl_core::BoardProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key: row.get(2)?,
                    counter: row.get(3)?,
                    github_repo: row.get(4)?,
                })
            },
        ).ok().map(Ok).transpose()
    }

    pub fn list_board_projects(&self) -> Result<Vec<gctl_core::BoardProject>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, key, counter, github_repo FROM board_projects ORDER BY name")
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([], |row| {
            Ok(gctl_core::BoardProject {
                id: row.get(0)?,
                name: row.get(1)?,
                key: row.get(2)?,
                counter: row.get(3)?,
                github_repo: row.get(4)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn update_board_project_github_repo(&self, id: &str, github_repo: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE board_projects SET github_repo = ?1 WHERE id = ?2",
            params![github_repo, id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn increment_project_counter(&self, project_id: &str) -> Result<i32> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE board_projects SET counter = counter + 1 WHERE id = ?1",
            [project_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let counter: i32 = conn.query_row(
            "SELECT counter FROM board_projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(counter)
    }

    pub fn insert_board_issue(&self, issue: &gctl_core::BoardIssue) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_issues (id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                issue.id,
                issue.project_id,
                issue.title,
                issue.description,
                issue.status.as_str(),
                issue.priority,
                issue.assignee_id,
                issue.assignee_name,
                issue.assignee_type,
                serde_json::to_string(&issue.labels).unwrap_or_else(|_| "[]".into()),
                issue.parent_id,
                issue.created_at.to_rfc3339(),
                issue.updated_at.to_rfc3339(),
                issue.created_by_id,
                issue.created_by_name,
                issue.created_by_type,
                serde_json::to_string(&issue.blocked_by).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&issue.blocking).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&issue.session_ids).unwrap_or_else(|_| "[]".into()),
                issue.total_cost_usd,
                issue.total_tokens as i64,
                serde_json::to_string(&issue.pr_numbers).unwrap_or_else(|_| "[]".into()),
                issue.content_hash,
                issue.source_path,
                issue.github_issue_number.map(|n| n as i32),
                issue.github_url,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Upsert a board issue — insert or update if content_hash changed.
    /// Used by markdown import. Preserves session_ids, cost, and tokens from existing record.
    pub fn upsert_board_issue(&self, issue: &gctl_core::BoardIssue) -> Result<bool> {
        // Check if exists and if content changed
        if let Some(existing) = self.get_board_issue(&issue.id)? {
            if existing.content_hash == issue.content_hash {
                return Ok(false); // No change
            }
            // Update mutable fields from markdown, preserve kernel-managed fields
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE board_issues SET title = ?1, description = ?2, status = ?3, priority = ?4,
                 assignee_id = ?5, assignee_name = ?6, assignee_type = ?7,
                 labels = ?8, parent_id = ?9, updated_at = ?10,
                 content_hash = ?11, source_path = ?12
                 WHERE id = ?13",
                params![
                    issue.title,
                    issue.description,
                    issue.status.as_str(),
                    issue.priority,
                    issue.assignee_id,
                    issue.assignee_name,
                    issue.assignee_type,
                    serde_json::to_string(&issue.labels).unwrap_or_else(|_| "[]".into()),
                    issue.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                    issue.content_hash,
                    issue.source_path,
                    issue.id,
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true)
        } else {
            self.insert_board_issue(issue)?;
            Ok(true)
        }
    }

    pub fn get_board_issue(&self, id: &str) -> Result<Option<gctl_core::BoardIssue>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url FROM board_issues WHERE id = ?1",
            [id],
            row_to_board_issue,
        ).ok().map(Ok).transpose()
    }

    pub fn list_board_issues(&self, filter: &gctl_core::BoardIssueFilter) -> Result<Vec<gctl_core::BoardIssue>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, project_id, title, description, status, priority, assignee_id, assignee_name, assignee_type, labels, parent_id, created_at, updated_at, created_by_id, created_by_name, created_by_type, blocked_by, blocking, session_ids, total_cost_usd, total_tokens, pr_numbers, content_hash, source_path, github_issue_number, github_url FROM board_issues WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref pid) = filter.project_id {
            sql.push_str(&format!(" AND project_id = ?{}", idx));
            params_vec.push(Box::new(pid.clone()));
            idx += 1;
        }
        if let Some(ref status) = filter.status {
            sql.push_str(&format!(" AND status = ?{}", idx));
            params_vec.push(Box::new(status.clone()));
            idx += 1;
        }
        if let Some(ref aid) = filter.assignee_id {
            sql.push_str(&format!(" AND assignee_id = ?{}", idx));
            params_vec.push(Box::new(aid.clone()));
            idx += 1;
        }
        sql.push_str(" ORDER BY updated_at DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_board_issue)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn update_board_issue_status(&self, id: &str, status: &str, actor_id: &str, actor_name: &str, actor_type: &str) -> Result<()> {
        let target = gctl_core::IssueStatus::from_str(status)
            .ok_or_else(|| GctlError::Storage(format!("invalid status: {}", status)))?;

        // Get current status
        let conn = self.conn.lock().unwrap();
        let current_str: String = conn.query_row(
            "SELECT status FROM board_issues WHERE id = ?1",
            [id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(format!("issue not found: {} ({})", id, e)))?;

        let current = gctl_core::IssueStatus::from_str(&current_str)
            .unwrap_or(gctl_core::IssueStatus::Backlog);

        // Compute transition path: direct if valid, otherwise auto-transit forward
        let path = if current.can_transition_to(&target) {
            vec![target]
        } else if let Some(fwd) = current.forward_path_to(&target) {
            fwd
        } else {
            return Err(GctlError::Storage(format!(
                "invalid transition: {} → {} (allowed: {})",
                current.as_str(),
                target.as_str(),
                current.valid_transitions().iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
            )));
        };

        // Apply each step, emitting an event for every intermediate transition
        let mut prev_str = current_str;
        for step in &path {
            let now = chrono::Utc::now();
            let step_str = step.as_str();
            conn.execute(
                "UPDATE board_issues SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![step_str, now.to_rfc3339(), id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;

            let event_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO board_events (id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data)
                 VALUES (?, ?, 'status_changed', ?, ?, ?, ?, ?)",
                params![
                    event_id, id, actor_id, actor_name, actor_type, now.to_rfc3339(),
                    serde_json::to_string(&serde_json::json!({"from": prev_str, "to": step_str})).unwrap(),
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            prev_str = step_str.to_string();
        }

        Ok(())
    }

    /// Find in_progress issues with no assignee and move them back to todo.
    /// Returns the number of issues reconciled.
    pub fn reconcile_stale_in_progress(&self) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Find stale issues: in_progress with no assignee
        let mut stmt = conn.prepare(
            "SELECT id FROM board_issues WHERE status = 'in_progress' AND assignee_id IS NULL"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        let ids: Vec<String> = stmt.query_map([], |row| row.get(0))
            .map_err(|e| GctlError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        let count = ids.len() as u32;
        for id in &ids {
            conn.execute(
                "UPDATE board_issues SET status = 'todo', updated_at = ?1 WHERE id = ?2",
                params![now, id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;

            let event_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO board_events (id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data)
                 VALUES (?, ?, 'status_changed', 'gctl-reconcile', 'gctl-reconcile', 'system', ?, ?)",
                params![
                    event_id, id, now,
                    serde_json::to_string(&serde_json::json!({"from": "in_progress", "to": "todo", "reason": "no assignee"})).unwrap(),
                ],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
        }

        Ok(count)
    }

    pub fn assign_board_issue(&self, id: &str, assignee_id: &str, assignee_name: &str, assignee_type: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE board_issues SET assignee_id = ?1, assignee_name = ?2, assignee_type = ?3, updated_at = ?4 WHERE id = ?5",
            params![assignee_id, assignee_name, assignee_type, now, id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn insert_board_event(&self, event: &gctl_core::BoardEvent) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_events (id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                event.id, event.issue_id, event.event_type,
                event.actor_id, event.actor_name, event.actor_type,
                event.timestamp.to_rfc3339(),
                serde_json::to_string(&event.data).unwrap_or_else(|_| "null".into()),
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn list_board_events(&self, issue_id: &str) -> Result<Vec<gctl_core::BoardEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, type, actor_id, actor_name, actor_type, timestamp, data FROM board_events WHERE issue_id = ?1 ORDER BY timestamp"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([issue_id], |row| {
            let ts: String = row.get(6)?;
            let data_str: String = row.get(7)?;
            Ok(gctl_core::BoardEvent {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                event_type: row.get(2)?,
                actor_id: row.get(3)?,
                actor_name: row.get(4)?,
                actor_type: row.get(5)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                data: serde_json::from_str(&data_str).unwrap_or(serde_json::Value::Null),
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn insert_board_comment(&self, comment: &gctl_core::BoardComment) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_comments (id, issue_id, author_id, author_name, author_type, body, created_at, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                comment.id, comment.issue_id,
                comment.author_id, comment.author_name, comment.author_type,
                comment.body, comment.created_at.to_rfc3339(), comment.session_id,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn list_board_comments(&self, issue_id: &str) -> Result<Vec<gctl_core::BoardComment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, issue_id, author_id, author_name, author_type, body, created_at, session_id FROM board_comments WHERE issue_id = ?1 ORDER BY created_at"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map([issue_id], |row| {
            let ts: String = row.get(6)?;
            Ok(gctl_core::BoardComment {
                id: row.get(0)?,
                issue_id: row.get(1)?,
                author_id: row.get(2)?,
                author_name: row.get(3)?,
                author_type: row.get(4)?,
                body: row.get(5)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&ts)
                    .map(|dt| dt.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                session_id: row.get(7)?,
            })
        }).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn link_session_to_issue(&self, issue_id: &str, session_id: &str, cost: f64, tokens: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Read current session_ids, append, write back
        let current: String = conn.query_row(
            "SELECT session_ids FROM board_issues WHERE id = ?1",
            [issue_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        let mut ids: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
        if !ids.contains(&session_id.to_string()) {
            ids.push(session_id.to_string());
        }
        let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());

        conn.execute(
            "UPDATE board_issues SET
                session_ids = ?1,
                total_cost_usd = total_cost_usd + ?2,
                total_tokens = total_tokens + ?3,
                updated_at = ?4
             WHERE id = ?5",
            params![ids_json, cost, tokens as i64, now, issue_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════
    // Persona CRUD
    // ═══════════════════════════════════════════════════════════════

    pub fn upsert_persona(&self, persona: &PersonaDefinition) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let tools_json = serde_json::to_string(&persona.tools).unwrap_or_else(|_| "[]".into());
        let specs_json = serde_json::to_string(&persona.key_specs).unwrap_or_else(|_| "[]".into());

        // Check if exists
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM persona_definitions WHERE id = ?1",
            [&persona.id],
            |row| row.get(0),
        ).unwrap_or(false);

        if exists {
            conn.execute(
                "UPDATE persona_definitions SET name = ?1, focus = ?2, prompt_prefix = ?3, owns = ?4, review_focus = ?5, pushes_back = ?6, tools = ?7, key_specs = ?8, updated_at = ?9, source_hash = ?10 WHERE id = ?11",
                params![persona.name, persona.focus, persona.prompt_prefix, persona.owns, persona.review_focus, persona.pushes_back, tools_json, specs_json, now, persona.source_hash, persona.id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false) // updated
        } else {
            conn.execute(
                "INSERT INTO persona_definitions (id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, created_at, updated_at, source_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![persona.id, persona.name, persona.focus, persona.prompt_prefix, persona.owns, persona.review_focus, persona.pushes_back, tools_json, specs_json, now, now, persona.source_hash],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true) // created
        }
    }

    pub fn get_persona(&self, id: &str) -> Result<Option<PersonaDefinition>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, source_hash FROM persona_definitions WHERE id = ?1",
            [id],
            |row| {
                let tools_str: String = row.get(7)?;
                let specs_str: String = row.get(8)?;
                Ok(PersonaDefinition {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    focus: row.get(2)?,
                    prompt_prefix: row.get(3)?,
                    owns: row.get(4)?,
                    review_focus: row.get(5)?,
                    pushes_back: row.get(6)?,
                    tools: serde_json::from_str(&tools_str).unwrap_or_default(),
                    key_specs: serde_json::from_str(&specs_str).unwrap_or_default(),
                    source_hash: row.get(9)?,
                })
            },
        ).ok().map(Ok).transpose()
    }

    pub fn list_personas(&self) -> Result<Vec<PersonaDefinition>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, focus, prompt_prefix, owns, review_focus, pushes_back, tools, key_specs, source_hash FROM persona_definitions ORDER BY name"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut personas = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let tools_str: String = row.get(7).unwrap_or_default();
            let specs_str: String = row.get(8).unwrap_or_default();
            personas.push(PersonaDefinition {
                id: row.get(0).unwrap_or_default(),
                name: row.get(1).unwrap_or_default(),
                focus: row.get(2).unwrap_or_default(),
                prompt_prefix: row.get(3).unwrap_or_default(),
                owns: row.get(4).unwrap_or_default(),
                review_focus: row.get(5).unwrap_or_default(),
                pushes_back: row.get(6).unwrap_or_default(),
                tools: serde_json::from_str(&tools_str).unwrap_or_default(),
                key_specs: serde_json::from_str(&specs_str).unwrap_or_default(),
                source_hash: row.get(9).ok(),
            });
        }
        Ok(personas)
    }

    pub fn delete_persona(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM persona_definitions WHERE id = ?1", [id])
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(affected > 0)
    }

    pub fn upsert_review_rule(&self, rule: &PersonaReviewRule) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let ids_json = serde_json::to_string(&rule.persona_ids).unwrap_or_else(|_| "[]".into());

        // Check if exists by id
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM persona_review_rules WHERE id = ?1",
            [&rule.id],
            |row| row.get(0),
        ).unwrap_or(false);

        if exists {
            conn.execute(
                "UPDATE persona_review_rules SET pr_type = ?1, persona_ids = ?2, created_at = ?3 WHERE id = ?4",
                params![rule.pr_type, ids_json, now, rule.id],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(false) // updated
        } else {
            conn.execute(
                "INSERT INTO persona_review_rules (id, pr_type, persona_ids, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![rule.id, rule.pr_type, ids_json, now],
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            Ok(true) // created
        }
    }

    pub fn list_review_rules(&self) -> Result<Vec<PersonaReviewRule>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, pr_type, persona_ids FROM persona_review_rules ORDER BY pr_type"
        ).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
        let mut rules = Vec::new();
        while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
            let ids_str: String = row.get(2).unwrap_or_default();
            rules.push(PersonaReviewRule {
                id: row.get(0).unwrap_or_default(),
                pr_type: row.get(1).unwrap_or_default(),
                persona_ids: serde_json::from_str(&ids_str).unwrap_or_default(),
            });
        }
        Ok(rules)
    }

    pub fn get_review_rule_by_type(&self, pr_type: &str) -> Result<Option<PersonaReviewRule>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, pr_type, persona_ids FROM persona_review_rules WHERE pr_type = ?1",
            [pr_type],
            |row| {
                let ids_str: String = row.get(2)?;
                Ok(PersonaReviewRule {
                    id: row.get(0)?,
                    pr_type: row.get(1)?,
                    persona_ids: serde_json::from_str(&ids_str).unwrap_or_default(),
                })
            },
        ).ok().map(Ok).transpose()
    }

    // ═══════════════════════════════════════════════════════════════
    // Inbox application
    // ═══════════════════════════════════════════════════════════════

    pub fn get_or_create_inbox_thread(
        &self,
        context_type: &str,
        context_ref: &str,
        title: &str,
        project_key: Option<&str>,
    ) -> Result<InboxThread> {
        let conn = self.conn.lock().unwrap();
        // Try to find existing thread by context_type + context_ref
        let existing = conn.query_row(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE context_type = ?1 AND context_ref = ?2",
            params![context_type, context_ref],
            row_to_inbox_thread,
        );
        if let Ok(thread) = existing {
            return Ok(thread);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO inbox_threads (id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 'info', ?6, ?7)",
            params![id, context_type, context_ref, title, project_key, now, now],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(InboxThread {
            id,
            context_type: context_type.into(),
            context_ref: context_ref.into(),
            title: title.into(),
            project_key: project_key.map(|s| s.into()),
            pending_count: 0,
            latest_urgency: "info".into(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn create_inbox_message(&self, msg: &InboxMessage) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO inbox_messages (id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                msg.id,
                msg.thread_id,
                msg.source,
                msg.kind,
                msg.urgency,
                msg.title,
                msg.body,
                serde_json::to_string(&msg.context).unwrap_or_else(|_| "{}".into()),
                msg.status,
                msg.requires_action,
                msg.payload.as_ref().map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".into())),
                msg.duplicate_count as i32,
                msg.snoozed_until,
                msg.expires_at,
                msg.created_at,
                msg.updated_at,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Update thread pending_count and latest_urgency if message is pending
        if msg.status == "pending" {
            self.recalc_thread_counts_with_conn(&conn, &msg.thread_id)?;
        }
        Ok(())
    }

    pub fn get_inbox_message(&self, id: &str) -> Result<Option<InboxMessage>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at
             FROM inbox_messages WHERE id = ?1",
            [id],
            row_to_inbox_message,
        ).ok().map(Ok).transpose()
    }

    pub fn list_inbox_messages(&self, filter: &InboxMessageFilter) -> Result<Vec<InboxMessage>> {
        let conn = self.conn.lock().unwrap();
        let needs_join = filter.project.is_some();
        let col = |name: &str| -> String {
            if needs_join { format!("m.{}", name) } else { name.to_string() }
        };

        let base = if needs_join {
            "SELECT m.id, m.thread_id, m.source, m.kind, m.urgency, m.title, m.body, m.context, m.status, m.requires_action, m.payload, m.duplicate_count, m.snoozed_until, m.expires_at, m.created_at, m.updated_at
             FROM inbox_messages m JOIN inbox_threads t ON m.thread_id = t.id WHERE 1=1".to_string()
        } else {
            "SELECT id, thread_id, source, kind, urgency, title, body, context, status, requires_action, payload, duplicate_count, snoozed_until, expires_at, created_at, updated_at
             FROM inbox_messages WHERE 1=1".to_string()
        };

        let mut sql = base;
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref project) = filter.project {
            sql.push_str(&format!(" AND t.project_key = ?{}", idx));
            params_vec.push(Box::new(project.clone()));
            idx += 1;
        }
        if let Some(ref thread_id) = filter.thread_id {
            sql.push_str(&format!(" AND {} = ?{}", col("thread_id"), idx));
            params_vec.push(Box::new(thread_id.clone()));
            idx += 1;
        }
        if let Some(ref status) = filter.status {
            sql.push_str(&format!(" AND {} = ?{}", col("status"), idx));
            params_vec.push(Box::new(status.clone()));
            idx += 1;
        }
        if let Some(ref urgency) = filter.urgency {
            sql.push_str(&format!(" AND {} = ?{}", col("urgency"), idx));
            params_vec.push(Box::new(urgency.clone()));
            idx += 1;
        }
        if let Some(ref kind) = filter.kind {
            sql.push_str(&format!(" AND {} = ?{}", col("kind"), idx));
            params_vec.push(Box::new(kind.clone()));
            idx += 1;
        }
        if let Some(requires_action) = filter.requires_action {
            sql.push_str(&format!(" AND {} = ?{}", col("requires_action"), idx));
            params_vec.push(Box::new(requires_action));
            idx += 1;
        }
        sql.push_str(&format!(" ORDER BY {} DESC", col("created_at")));
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_message)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_inbox_thread(&self, id: &str) -> Result<Option<InboxThread>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE id = ?1",
            [id],
            row_to_inbox_thread,
        ).ok().map(Ok).transpose()
    }

    pub fn list_inbox_threads(
        &self,
        project: Option<&str>,
        has_pending: Option<bool>,
        limit: Option<usize>,
    ) -> Result<Vec<InboxThread>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, context_type, context_ref, title, project_key, pending_count, latest_urgency, created_at, updated_at
             FROM inbox_threads WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(project) = project {
            sql.push_str(&format!(" AND project_key = ?{}", idx));
            params_vec.push(Box::new(project.to_string()));
            idx += 1;
        }
        if let Some(true) = has_pending {
            sql.push_str(" AND pending_count > 0");
        } else if let Some(false) = has_pending {
            sql.push_str(" AND pending_count = 0");
        }
        sql.push_str(" ORDER BY pending_count DESC, updated_at DESC");
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_thread)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn create_inbox_action(&self, action: &InboxAction) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Validate message is pending
        let status: String = conn.query_row(
            "SELECT status FROM inbox_messages WHERE id = ?1",
            [&action.message_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(format!("message not found: {}", e)))?;

        if status != "pending" {
            return Err(GctlError::Storage(format!(
                "cannot act on message with status '{}' (expected 'pending')",
                status
            )));
        }

        // Insert action
        conn.execute(
            "INSERT INTO inbox_actions (id, message_id, thread_id, actor_id, actor_name, action_type, reason, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                action.id,
                action.message_id,
                action.thread_id,
                action.actor_id,
                action.actor_name,
                action.action_type,
                action.reason,
                action.metadata.as_ref().map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".into())),
                action.created_at,
            ],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Update message status to 'acted'
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE inbox_messages SET status = 'acted', updated_at = ?1 WHERE id = ?2",
            params![now, action.message_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Recalc thread counts
        self.recalc_thread_counts_with_conn(&conn, &action.thread_id)?;

        Ok(())
    }

    pub fn list_inbox_actions(&self, filter: &InboxActionFilter) -> Result<Vec<InboxAction>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT id, message_id, thread_id, actor_id, actor_name, action_type, reason, metadata, created_at
             FROM inbox_actions WHERE 1=1"
        );
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref actor_id) = filter.actor_id {
            sql.push_str(&format!(" AND actor_id = ?{}", idx));
            params_vec.push(Box::new(actor_id.clone()));
            idx += 1;
        }
        if let Some(ref since) = filter.since {
            sql.push_str(&format!(" AND created_at >= ?{}", idx));
            params_vec.push(Box::new(since.clone()));
            idx += 1;
        }
        if let Some(ref thread_id) = filter.thread_id {
            sql.push_str(&format!(" AND thread_id = ?{}", idx));
            params_vec.push(Box::new(thread_id.clone()));
            idx += 1;
        }
        sql.push_str(" ORDER BY created_at DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", idx));
            params_vec.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| GctlError::Storage(e.to_string()))?;
        let rows = stmt.query_map(param_refs.as_slice(), row_to_inbox_action)
            .map_err(|e| GctlError::Storage(e.to_string()))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn recalc_thread_counts(&self, thread_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        self.recalc_thread_counts_with_conn(&conn, thread_id)
    }

    fn recalc_thread_counts_with_conn(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<()> {
        let pending_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE thread_id = ?1 AND status = 'pending'",
            [thread_id],
            |row| row.get(0),
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        // Compute latest_urgency as the highest urgency among pending messages
        let urgency_order = ["critical", "high", "medium", "low", "info"];
        let latest_urgency = if pending_count > 0 {
            let mut best = "info";
            let mut stmt = conn.prepare(
                "SELECT DISTINCT urgency FROM inbox_messages WHERE thread_id = ?1 AND status = 'pending'"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([thread_id]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let u: String = row.get(0).unwrap_or_default();
                let u_pos = urgency_order.iter().position(|&x| x == u).unwrap_or(4);
                let best_pos = urgency_order.iter().position(|&x| x == best).unwrap_or(4);
                if u_pos < best_pos {
                    best = urgency_order[u_pos];
                }
            }
            best
        } else {
            "info"
        };

        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE inbox_threads SET pending_count = ?1, latest_urgency = ?2, updated_at = ?3 WHERE id = ?4",
            params![pending_count, latest_urgency, now, thread_id],
        ).map_err(|e| GctlError::Storage(e.to_string()))?;

        Ok(())
    }

    pub fn get_inbox_stats(&self) -> Result<serde_json::Value> {
        let conn = self.conn.lock().unwrap();

        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages", [], |row| row.get(0),
        ).unwrap_or(0);

        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE status = 'pending'", [], |row| row.get(0),
        ).unwrap_or(0);

        let acted: i64 = conn.query_row(
            "SELECT COUNT(*) FROM inbox_messages WHERE status = 'acted'", [], |row| row.get(0),
        ).unwrap_or(0);

        // By urgency (pending only)
        let mut by_urgency = serde_json::Map::new();
        {
            let mut stmt = conn.prepare(
                "SELECT urgency, COUNT(*) FROM inbox_messages WHERE status = 'pending' GROUP BY urgency"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let urgency: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_urgency.insert(urgency, serde_json::Value::Number(count.into()));
            }
        }

        // By kind (pending only)
        let mut by_kind = serde_json::Map::new();
        {
            let mut stmt = conn.prepare(
                "SELECT kind, COUNT(*) FROM inbox_messages WHERE status = 'pending' GROUP BY kind"
            ).map_err(|e| GctlError::Storage(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| GctlError::Storage(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| GctlError::Storage(e.to_string()))? {
                let kind: String = row.get(0).unwrap_or_default();
                let count: i64 = row.get(1).unwrap_or(0);
                by_kind.insert(kind, serde_json::Value::Number(count.into()));
            }
        }

        Ok(serde_json::json!({
            "total": total,
            "pending": pending,
            "acted": acted,
            "by_urgency": by_urgency,
            "by_kind": by_kind,
        }))
    }
}

fn row_to_board_issue(row: &duckdb::Row<'_>) -> duckdb::Result<gctl_core::BoardIssue> {
    let status_str: String = row.get(4)?;
    let labels_str: String = row.get(9)?;
    let created_at_str: String = row.get(11)?;
    let updated_at_str: String = row.get(12)?;
    let blocked_by_str: String = row.get(16)?;
    let blocking_str: String = row.get(17)?;
    let session_ids_str: String = row.get(18)?;
    let pr_numbers_str: String = row.get(21)?;

    Ok(gctl_core::BoardIssue {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        status: gctl_core::IssueStatus::from_str(&status_str).unwrap_or(gctl_core::IssueStatus::Backlog),
        priority: row.get(5)?,
        assignee_id: row.get(6)?,
        assignee_name: row.get(7)?,
        assignee_type: row.get(8)?,
        labels: serde_json::from_str(&labels_str).unwrap_or_default(),
        parent_id: row.get(10)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        created_by_id: row.get(13)?,
        created_by_name: row.get(14)?,
        created_by_type: row.get(15)?,
        blocked_by: serde_json::from_str(&blocked_by_str).unwrap_or_default(),
        blocking: serde_json::from_str(&blocking_str).unwrap_or_default(),
        session_ids: serde_json::from_str(&session_ids_str).unwrap_or_default(),
        total_cost_usd: row.get(19)?,
        total_tokens: { let v: i64 = row.get(20)?; v as u64 },
        pr_numbers: serde_json::from_str(&pr_numbers_str).unwrap_or_default(),
        content_hash: row.get(22)?,
        source_path: row.get(23)?,
        github_issue_number: { let v: Option<i32> = row.get(24)?; v.map(|n| n as u32) },
        github_url: row.get(25)?,
    })
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

fn row_to_inbox_message(row: &duckdb::Row<'_>) -> duckdb::Result<InboxMessage> {
    let context_str: String = row.get(7)?;
    let payload_str: Option<String> = row.get(10)?;
    Ok(InboxMessage {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        source: row.get(2)?,
        kind: row.get(3)?,
        urgency: row.get(4)?,
        title: row.get(5)?,
        body: row.get(6)?,
        context: serde_json::from_str(&context_str).unwrap_or(serde_json::json!({})),
        status: row.get(8)?,
        requires_action: row.get(9)?,
        payload: payload_str.and_then(|s| serde_json::from_str(&s).ok()),
        duplicate_count: { let v: i32 = row.get(11)?; v as u32 },
        snoozed_until: row.get(12)?,
        expires_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn row_to_inbox_thread(row: &duckdb::Row<'_>) -> duckdb::Result<InboxThread> {
    Ok(InboxThread {
        id: row.get(0)?,
        context_type: row.get(1)?,
        context_ref: row.get(2)?,
        title: row.get(3)?,
        project_key: row.get(4)?,
        pending_count: row.get(5)?,
        latest_urgency: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_inbox_action(row: &duckdb::Row<'_>) -> duckdb::Result<InboxAction> {
    let metadata_str: Option<String> = row.get(7)?;
    Ok(InboxAction {
        id: row.get(0)?,
        message_id: row.get(1)?,
        thread_id: row.get(2)?,
        actor_id: row.get(3)?,
        actor_name: row.get(4)?,
        action_type: row.get(5)?,
        reason: row.get(6)?,
        metadata: metadata_str.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: row.get(8)?,
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

    #[test]
    fn test_end_session() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.end_session("s1", "completed").unwrap();

        let session = store.get_session(&SessionId("s1".into())).unwrap().unwrap();
        assert_eq!(session.status, SessionStatus::Completed);
        assert!(session.ended_at.is_some());
    }

    #[test]
    fn test_detect_error_loops_none() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        // 3 different operations — no loop
        let mut s1 = make_span("sp1", "s1");
        s1.operation_name = "llm.call".into();
        let mut s2 = make_span("sp2", "s1");
        s2.operation_name = "tool.bash".into();
        let mut s3 = make_span("sp3", "s1");
        s3.operation_name = "tool.read".into();
        store.insert_spans(&[s1, s2, s3]).unwrap();

        let loops = store.detect_error_loops("s1", 3).unwrap();
        assert!(loops.is_empty());
    }

    #[test]
    fn test_detect_error_loops_found() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        // 3 identical operations — loop detected
        let mut spans = Vec::new();
        for i in 0..3 {
            let mut s = make_span(&format!("sp{i}"), "s1");
            s.operation_name = "tool.read".into();
            spans.push(s);
        }
        store.insert_spans(&spans).unwrap();

        let loops = store.detect_error_loops("s1", 3).unwrap();
        assert_eq!(loops.len(), 1);
        assert!(loops[0].contains("tool.read"));
    }

    #[test]
    fn test_span_type_distribution() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let mut gen_span = make_span("sp1", "s1");
        gen_span.span_type = SpanType::Generation;
        let mut tool_span = make_span("sp2", "s1");
        tool_span.span_type = SpanType::Span;
        tool_span.model = None;
        let mut event_span = make_span("sp3", "s1");
        event_span.span_type = SpanType::Event;
        event_span.model = None;

        store.insert_spans(&[gen_span, tool_span, event_span]).unwrap();

        let dist = store.get_span_type_distribution().unwrap();
        assert_eq!(dist.len(), 3);
        let total: u64 = dist.iter().map(|(_, c, _)| c).sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_span_type_distribution_empty() {
        let store = test_store();
        let dist = store.get_span_type_distribution().unwrap();
        assert!(dist.is_empty());
    }

    #[test]
    fn test_health_info() {
        let store = test_store();
        let info = store.get_health_info().unwrap();
        assert_eq!(info["sessions"], 0);
        assert_eq!(info["spans"], 0);
    }

    #[test]
    fn test_list_sessions_filtered_by_agent() {
        let store = test_store();
        let mut s1 = make_session("s1");
        s1.agent_name = "claude".into();
        let mut s2 = make_session("s2");
        s2.agent_name = "aider".into();
        store.insert_session(&s1).unwrap();
        store.insert_session(&s2).unwrap();

        let filtered = store.list_sessions_filtered(20, Some("claude"), None).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].agent_name, "claude");
    }

    #[test]
    fn test_list_sessions_filtered_by_status() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.end_session("s1", "completed").unwrap();
        store.insert_session(&make_session("s2")).unwrap();

        let filtered = store.list_sessions_filtered(20, None, Some("completed")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id.0, "s1");
    }

    #[test]
    fn test_session_cost_breakdown() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();

        let mut s1 = make_span("sp1", "s1");
        s1.model = Some("claude-opus-4-6".into());
        s1.cost_usd = 0.10;
        let mut s2 = make_span("sp2", "s1");
        s2.model = Some("claude-haiku-4-5".into());
        s2.cost_usd = 0.01;

        store.insert_spans(&[s1, s2]).unwrap();

        let breakdown = store.get_session_cost_breakdown("s1").unwrap();
        assert_eq!(breakdown.len(), 2);
        assert_eq!(breakdown[0].0, "claude-opus-4-6");
        assert!((breakdown[0].1 - 0.10).abs() < 0.001);
    }

    #[test]
    fn test_session_cost_breakdown_empty() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        let breakdown = store.get_session_cost_breakdown("s1").unwrap();
        assert!(breakdown.is_empty());
    }

    #[test]
    fn test_compute_daily_aggregates() {
        let store = test_store();
        store.insert_session(&make_session("s1")).unwrap();
        store.insert_spans(&[make_span("sp1", "s1"), make_span("sp2", "s1")]).unwrap();

        // Get the date from the session's started_at
        let session = store.get_session(&SessionId("s1".into())).unwrap().unwrap();
        let date = session.started_at.format("%Y-%m-%d").to_string();

        let aggs = store.compute_daily_aggregates(&date).unwrap();
        assert!(aggs.len() >= 4);

        let cost_agg = aggs.iter().find(|a| a.metric == "cost").unwrap();
        assert!((cost_agg.value - 0.10).abs() < 0.001); // 2 spans * $0.05

        let session_agg = aggs.iter().find(|a| a.metric == "sessions").unwrap();
        assert!((session_agg.value - 1.0).abs() < f64::EPSILON);

        let span_agg = aggs.iter().find(|a| a.metric == "spans").unwrap();
        assert!((span_agg.value - 2.0).abs() < f64::EPSILON);
    }

    // ═══════════════════════════════════════════════════════════════
    // Board tests
    // ═══════════════════════════════════════════════════════════════

    fn make_project(id: &str, key: &str) -> gctl_core::BoardProject {
        gctl_core::BoardProject {
            id: id.into(),
            name: format!("Project {}", key),
            key: key.into(),
            counter: 0,
            github_repo: None,
        }
    }

    fn make_issue(id: &str, project_id: &str) -> gctl_core::BoardIssue {
        gctl_core::BoardIssue {
            id: id.into(),
            project_id: project_id.into(),
            title: format!("Issue {}", id),
            description: None,
            status: gctl_core::IssueStatus::Backlog,
            priority: "none".into(),
            assignee_id: None,
            assignee_name: None,
            assignee_type: None,
            labels: vec![],
            parent_id: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            created_by_id: "user1".into(),
            created_by_name: "Alice".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: None,
            source_path: None,
            github_issue_number: None,
            github_url: None,
        }
    }

    #[test]
    fn test_board_project_crud() {
        let store = test_store();
        let project = make_project("p1", "BACK");
        store.create_board_project(&project).unwrap();

        let fetched = store.get_board_project("p1").unwrap().unwrap();
        assert_eq!(fetched.key, "BACK");
        assert_eq!(fetched.counter, 0);

        let projects = store.list_board_projects().unwrap();
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn test_board_project_counter() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();

        let c1 = store.increment_project_counter("p1").unwrap();
        assert_eq!(c1, 1);
        let c2 = store.increment_project_counter("p1").unwrap();
        assert_eq!(c2, 2);
    }

    #[test]
    fn test_board_issue_crud() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();

        let issue = make_issue("i1", "p1");
        store.insert_board_issue(&issue).unwrap();

        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.title, "Issue i1");
        assert_eq!(fetched.status, gctl_core::IssueStatus::Backlog);
        assert_eq!(fetched.project_id, "p1");
    }

    #[test]
    fn test_board_issue_list_filter() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.create_board_project(&make_project("p2", "FRONT")).unwrap();

        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();
        store.insert_board_issue(&make_issue("i2", "p1")).unwrap();
        store.insert_board_issue(&make_issue("i3", "p2")).unwrap();

        let all = store.list_board_issues(&gctl_core::BoardIssueFilter::default()).unwrap();
        assert_eq!(all.len(), 3);

        let p1_only = store.list_board_issues(&gctl_core::BoardIssueFilter {
            project_id: Some("p1".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(p1_only.len(), 2);
    }

    #[test]
    fn test_board_issue_status_update() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        // backlog → todo (valid)
        store.update_board_issue_status("i1", "todo", "u1", "Alice", "human").unwrap();
        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.status, gctl_core::IssueStatus::Todo);

        // todo → in_progress (valid)
        store.update_board_issue_status("i1", "in_progress", "u1", "Alice", "human").unwrap();
        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.status, gctl_core::IssueStatus::InProgress);

        // Auto-emitted events
        let events = store.list_board_events("i1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "status_changed");
    }

    #[test]
    fn test_board_auto_transit_forward() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        // backlog → in_progress auto-transits through todo
        store.update_board_issue_status("i1", "in_progress", "u1", "Alice", "human").unwrap();
        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.status, gctl_core::IssueStatus::InProgress);

        // Two events emitted: backlog→todo, todo→in_progress
        let events = store.list_board_events("i1").unwrap();
        assert_eq!(events.len(), 2);

        // backlog → done auto-transits through all intermediate steps
        store.insert_board_issue(&make_issue("i2", "p1")).unwrap();
        store.update_board_issue_status("i2", "done", "u1", "Alice", "human").unwrap();
        let fetched = store.get_board_issue("i2").unwrap().unwrap();
        assert_eq!(fetched.status, gctl_core::IssueStatus::Done);
        let events = store.list_board_events("i2").unwrap();
        assert_eq!(events.len(), 4); // backlog→todo→in_progress→in_review→done
    }

    #[test]
    fn test_board_backward_transition_rejected() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        // Move to in_progress
        store.update_board_issue_status("i1", "in_progress", "u1", "Alice", "human").unwrap();

        // in_progress → backlog is backward (not a direct valid transition, not forward)
        let result = store.update_board_issue_status("i1", "backlog", "u1", "Alice", "human");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("invalid transition"));

        // Status unchanged
        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.status, gctl_core::IssueStatus::InProgress);
    }

    #[test]
    fn test_board_terminal_state_no_transitions() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        // Walk to done: backlog → todo → in_progress → in_review → done
        store.update_board_issue_status("i1", "todo", "u1", "Alice", "human").unwrap();
        store.update_board_issue_status("i1", "in_progress", "u1", "Alice", "human").unwrap();
        store.update_board_issue_status("i1", "in_review", "u1", "Alice", "human").unwrap();
        store.update_board_issue_status("i1", "done", "u1", "Alice", "human").unwrap();

        // done → anything (rejected)
        let result = store.update_board_issue_status("i1", "backlog", "u1", "Alice", "human");
        assert!(result.is_err());
    }

    #[test]
    fn test_board_cancel_from_any_non_terminal() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();

        // Cancel from backlog
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();
        store.update_board_issue_status("i1", "cancelled", "u1", "Alice", "human").unwrap();
        assert_eq!(store.get_board_issue("i1").unwrap().unwrap().status, gctl_core::IssueStatus::Cancelled);

        // Cancel from in_progress
        let mut issue2 = make_issue("i2", "p1");
        issue2.status = gctl_core::IssueStatus::Todo;
        store.insert_board_issue(&issue2).unwrap();
        store.update_board_issue_status("i2", "in_progress", "u1", "Alice", "human").unwrap();
        store.update_board_issue_status("i2", "cancelled", "u1", "Alice", "human").unwrap();
        assert_eq!(store.get_board_issue("i2").unwrap().unwrap().status, gctl_core::IssueStatus::Cancelled);
    }

    #[test]
    fn test_board_issue_assign() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        store.assign_board_issue("i1", "agent1", "claude-code", "agent").unwrap();
        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(fetched.assignee_id, Some("agent1".into()));
        assert_eq!(fetched.assignee_name, Some("claude-code".into()));
        assert_eq!(fetched.assignee_type, Some("agent".into()));
    }

    #[test]
    fn test_board_events() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        let event = gctl_core::BoardEvent {
            id: "e1".into(),
            issue_id: "i1".into(),
            event_type: "status_changed".into(),
            actor_id: "user1".into(),
            actor_name: "Alice".into(),
            actor_type: "human".into(),
            timestamp: chrono::Utc::now(),
            data: serde_json::json!({"from": "backlog", "to": "todo"}),
        };
        store.insert_board_event(&event).unwrap();

        let events = store.list_board_events("i1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "status_changed");
    }

    #[test]
    fn test_board_comments() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        let comment = gctl_core::BoardComment {
            id: "c1".into(),
            issue_id: "i1".into(),
            author_id: "user1".into(),
            author_name: "Alice".into(),
            author_type: "human".into(),
            body: "Looks good!".into(),
            created_at: chrono::Utc::now(),
            session_id: None,
        };
        store.insert_board_comment(&comment).unwrap();

        let comments = store.list_board_comments("i1").unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].body, "Looks good!");
    }

    #[test]
    fn test_board_link_session() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();
        store.insert_board_issue(&make_issue("i1", "p1")).unwrap();

        store.link_session_to_issue("i1", "sess-1", 1.50, 5000).unwrap();
        store.link_session_to_issue("i1", "sess-2", 0.75, 2500).unwrap();

        let fetched = store.get_board_issue("i1").unwrap().unwrap();
        assert!((fetched.total_cost_usd - 2.25).abs() < 0.01);
        assert_eq!(fetched.total_tokens, 7500);
        assert_eq!(fetched.session_ids.len(), 2);
    }

    #[test]
    fn test_board_reconcile_stale_in_progress() {
        let store = test_store();
        store.create_board_project(&make_project("p1", "BACK")).unwrap();

        // Issue with assignee — should NOT be moved back
        let mut assigned = make_issue("i1", "p1");
        assigned.status = gctl_core::IssueStatus::InProgress;
        assigned.assignee_id = Some("agent-1".into());
        assigned.assignee_name = Some("engineer".into());
        store.insert_board_issue(&assigned).unwrap();

        // Issue without assignee — SHOULD be moved back to todo
        let mut unassigned = make_issue("i2", "p1");
        unassigned.status = gctl_core::IssueStatus::InProgress;
        store.insert_board_issue(&unassigned).unwrap();

        // Issue in backlog — should NOT be touched
        let backlog = make_issue("i3", "p1");
        store.insert_board_issue(&backlog).unwrap();

        let moved = store.reconcile_stale_in_progress().unwrap();
        assert_eq!(moved, 1);

        let i1 = store.get_board_issue("i1").unwrap().unwrap();
        assert_eq!(i1.status.as_str(), "in_progress"); // assigned — kept

        let i2 = store.get_board_issue("i2").unwrap().unwrap();
        assert_eq!(i2.status.as_str(), "todo"); // unassigned — moved back

        let i3 = store.get_board_issue("i3").unwrap().unwrap();
        assert_eq!(i3.status.as_str(), "backlog"); // untouched
    }

    // ═══════════════════════════════════════════════════════════════
    // Persona tests
    // ═══════════════════════════════════════════════════════════════

    fn test_persona() -> PersonaDefinition {
        PersonaDefinition {
            id: "engineer".into(),
            name: "Principal Fullstack Engineer".into(),
            focus: "Architecture, code quality".into(),
            prompt_prefix: "You are a Principal Fullstack Engineer.".into(),
            owns: "Kernel crates, shell".into(),
            review_focus: "Hexagonal boundaries".into(),
            pushes_back: "Shortcuts bypass the shell".into(),
            tools: vec!["cargo build".into(), "cargo test".into()],
            key_specs: vec!["specs/architecture/".into()],
            source_hash: Some("hash123".into()),
        }
    }

    #[test]
    fn test_persona_crud() {
        let store = test_store();

        // Create
        let created = store.upsert_persona(&test_persona()).unwrap();
        assert!(created);

        // Read
        let persona = store.get_persona("engineer").unwrap().unwrap();
        assert_eq!(persona.name, "Principal Fullstack Engineer");
        assert_eq!(persona.tools.len(), 2);

        // Update (upsert existing)
        let mut updated = test_persona();
        updated.name = "Senior Engineer".into();
        let was_created = store.upsert_persona(&updated).unwrap();
        assert!(!was_created); // updated, not created

        let persona = store.get_persona("engineer").unwrap().unwrap();
        assert_eq!(persona.name, "Senior Engineer");

        // List
        let all = store.list_personas().unwrap();
        assert_eq!(all.len(), 1);

        // Delete
        let deleted = store.delete_persona("engineer").unwrap();
        assert!(deleted);
        assert!(store.get_persona("engineer").unwrap().is_none());
    }

    #[test]
    fn test_review_rule_crud() {
        let store = test_store();

        let rule = PersonaReviewRule {
            id: "rule-1".into(),
            pr_type: "new_kernel_primitive".into(),
            persona_ids: vec!["engineer".into(), "security".into(), "tech-lead".into()],
        };

        store.upsert_review_rule(&rule).unwrap();

        let rules = store.list_review_rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].persona_ids.len(), 3);

        let found = store.get_review_rule_by_type("new_kernel_primitive").unwrap().unwrap();
        assert_eq!(found.persona_ids, vec!["engineer", "security", "tech-lead"]);

        assert!(store.get_review_rule_by_type("nonexistent").unwrap().is_none());
    }

    // ═══════════════════════════════════════════════════════════════
    // Inbox tests
    // ═══════════════════════════════════════════════════════════════

    fn make_inbox_message(id: &str, thread_id: &str, urgency: &str) -> InboxMessage {
        let now = chrono::Utc::now().to_rfc3339();
        InboxMessage {
            id: id.into(),
            thread_id: thread_id.into(),
            source: "guardrail".into(),
            kind: "permission_request".into(),
            urgency: urgency.into(),
            title: format!("Message {}", id),
            body: None,
            context: serde_json::json!({"session_id": "sess-1", "issue_key": "BACK-42"}),
            status: "pending".into(),
            requires_action: true,
            payload: None,
            duplicate_count: 0,
            snoozed_until: None,
            expires_at: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn test_inbox_message_crud() {
        let store = test_store();

        // Create thread first
        let thread = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();
        assert_eq!(thread.context_type, "issue");
        assert_eq!(thread.context_ref, "BACK-42");
        assert_eq!(thread.pending_count, 0);

        // Create message
        let msg = make_inbox_message("msg-1", &thread.id, "high");
        store.create_inbox_message(&msg).unwrap();

        // Get
        let fetched = store.get_inbox_message("msg-1").unwrap().unwrap();
        assert_eq!(fetched.title, "Message msg-1");
        assert_eq!(fetched.urgency, "high");
        assert!(fetched.requires_action);

        // Thread pending_count updated
        let t = store.get_inbox_thread(&thread.id).unwrap().unwrap();
        assert_eq!(t.pending_count, 1);
        assert_eq!(t.latest_urgency, "high");

        // List with filter
        let all = store.list_inbox_messages(&InboxMessageFilter::default()).unwrap();
        assert_eq!(all.len(), 1);

        let by_urgency = store.list_inbox_messages(&InboxMessageFilter {
            urgency: Some("high".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(by_urgency.len(), 1);

        let by_low = store.list_inbox_messages(&InboxMessageFilter {
            urgency: Some("low".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(by_low.len(), 0);

        // Not found
        assert!(store.get_inbox_message("nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_inbox_action_idempotency() {
        let store = test_store();

        let thread = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();

        let msg = make_inbox_message("msg-1", &thread.id, "high");
        store.create_inbox_message(&msg).unwrap();

        // First action succeeds
        let action = InboxAction {
            id: "act-1".into(),
            message_id: "msg-1".into(),
            thread_id: thread.id.clone(),
            actor_id: "user-1".into(),
            actor_name: "Alice".into(),
            action_type: "approve".into(),
            reason: Some("Looks safe".into()),
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        store.create_inbox_action(&action).unwrap();

        // Message is now 'acted'
        let fetched = store.get_inbox_message("msg-1").unwrap().unwrap();
        assert_eq!(fetched.status, "acted");

        // Second action on same message fails
        let action2 = InboxAction {
            id: "act-2".into(),
            message_id: "msg-1".into(),
            thread_id: thread.id.clone(),
            actor_id: "user-2".into(),
            actor_name: "Bob".into(),
            action_type: "deny".into(),
            reason: Some("Too risky".into()),
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let result = store.create_inbox_action(&action2);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("acted"));
    }

    #[test]
    fn test_inbox_thread_auto_grouping() {
        let store = test_store();

        // First call creates thread
        let t1 = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();

        // Second call with same context_type + context_ref returns same thread
        let t2 = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "Different title", Some("BACK"),
        ).unwrap();

        assert_eq!(t1.id, t2.id);
        assert_eq!(t1.title, "BACK-42: Fix auth"); // Title from first creation

        // Different context_ref creates new thread
        let t3 = store.get_or_create_inbox_thread(
            "issue", "BACK-43", "BACK-43: New feature", Some("BACK"),
        ).unwrap();
        assert_ne!(t1.id, t3.id);

        // Two messages with same context join same thread
        let msg1 = make_inbox_message("msg-1", &t1.id, "high");
        let msg2 = make_inbox_message("msg-2", &t1.id, "medium");
        store.create_inbox_message(&msg1).unwrap();
        store.create_inbox_message(&msg2).unwrap();

        let thread = store.get_inbox_thread(&t1.id).unwrap().unwrap();
        assert_eq!(thread.pending_count, 2);
    }

    #[test]
    fn test_inbox_thread_pending_count() {
        let store = test_store();

        let thread = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();

        // Create 3 messages
        for i in 1..=3 {
            let msg = make_inbox_message(
                &format!("msg-{}", i),
                &thread.id,
                if i == 1 { "critical" } else { "medium" },
            );
            store.create_inbox_message(&msg).unwrap();
        }

        // Verify 3 pending
        let t = store.get_inbox_thread(&thread.id).unwrap().unwrap();
        assert_eq!(t.pending_count, 3);
        assert_eq!(t.latest_urgency, "critical");

        // Act on message 1
        let action = InboxAction {
            id: "act-1".into(),
            message_id: "msg-1".into(),
            thread_id: thread.id.clone(),
            actor_id: "user-1".into(),
            actor_name: "Alice".into(),
            action_type: "approve".into(),
            reason: None,
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        store.create_inbox_action(&action).unwrap();

        // Verify 2 pending, urgency recalculated (msg-1 was critical, remaining are medium)
        let t = store.get_inbox_thread(&thread.id).unwrap().unwrap();
        assert_eq!(t.pending_count, 2);
        assert_eq!(t.latest_urgency, "medium");

        // Act on remaining messages
        for i in 2..=3 {
            let action = InboxAction {
                id: format!("act-{}", i),
                message_id: format!("msg-{}", i),
                thread_id: thread.id.clone(),
                actor_id: "user-1".into(),
                actor_name: "Alice".into(),
                action_type: "acknowledge".into(),
                reason: None,
                metadata: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            store.create_inbox_action(&action).unwrap();
        }

        // Verify 0 pending, urgency reset to info
        let t = store.get_inbox_thread(&thread.id).unwrap().unwrap();
        assert_eq!(t.pending_count, 0);
        assert_eq!(t.latest_urgency, "info");
    }

    #[test]
    fn test_inbox_stats() {
        let store = test_store();

        let thread = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();

        // Create messages with different urgencies and kinds
        let mut msg1 = make_inbox_message("msg-1", &thread.id, "critical");
        msg1.kind = "permission_request".into();
        store.create_inbox_message(&msg1).unwrap();

        let mut msg2 = make_inbox_message("msg-2", &thread.id, "medium");
        msg2.kind = "budget_warning".into();
        msg2.requires_action = false;
        store.create_inbox_message(&msg2).unwrap();

        let stats = store.get_inbox_stats().unwrap();
        assert_eq!(stats["total"], 2);
        assert_eq!(stats["pending"], 2);
        assert_eq!(stats["acted"], 0);
        assert_eq!(stats["by_urgency"]["critical"], 1);
        assert_eq!(stats["by_urgency"]["medium"], 1);
        assert_eq!(stats["by_kind"]["permission_request"], 1);
        assert_eq!(stats["by_kind"]["budget_warning"], 1);
    }

    #[test]
    fn test_inbox_list_threads() {
        let store = test_store();

        let t1 = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();
        let t2 = store.get_or_create_inbox_thread(
            "issue", "FRONT-10", "FRONT-10: Dashboard", Some("FRONT"),
        ).unwrap();

        // Add a pending message to t1 only
        let msg = make_inbox_message("msg-1", &t1.id, "high");
        store.create_inbox_message(&msg).unwrap();

        // List all
        let all = store.list_inbox_threads(None, None, None).unwrap();
        assert_eq!(all.len(), 2);

        // Filter by project
        let back_only = store.list_inbox_threads(Some("BACK"), None, None).unwrap();
        assert_eq!(back_only.len(), 1);
        assert_eq!(back_only[0].context_ref, "BACK-42");

        // Filter by has_pending=true
        let with_pending = store.list_inbox_threads(None, Some(true), None).unwrap();
        assert_eq!(with_pending.len(), 1);
        assert_eq!(with_pending[0].id, t1.id);

        // Filter by has_pending=false
        let no_pending = store.list_inbox_threads(None, Some(false), None).unwrap();
        assert_eq!(no_pending.len(), 1);
        assert_eq!(no_pending[0].id, t2.id);
    }

    #[test]
    fn test_inbox_list_actions() {
        let store = test_store();

        let thread = store.get_or_create_inbox_thread(
            "issue", "BACK-42", "BACK-42: Fix auth", Some("BACK"),
        ).unwrap();

        let msg = make_inbox_message("msg-1", &thread.id, "high");
        store.create_inbox_message(&msg).unwrap();

        let action = InboxAction {
            id: "act-1".into(),
            message_id: "msg-1".into(),
            thread_id: thread.id.clone(),
            actor_id: "user-1".into(),
            actor_name: "Alice".into(),
            action_type: "approve".into(),
            reason: Some("Safe".into()),
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        store.create_inbox_action(&action).unwrap();

        // List all actions
        let actions = store.list_inbox_actions(&InboxActionFilter::default()).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].action_type, "approve");

        // Filter by actor
        let by_actor = store.list_inbox_actions(&InboxActionFilter {
            actor_id: Some("user-1".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(by_actor.len(), 1);

        let by_other = store.list_inbox_actions(&InboxActionFilter {
            actor_id: Some("user-999".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(by_other.len(), 0);
    }
}
