use std::path::Path;
use std::sync::Mutex;

use duckdb::{params, Connection};
use gctl_core::{
    Analytics, GctlError, Result, Session, SessionId, SessionStatus, Span, SpanStatus,
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
            "INSERT OR REPLACE INTO spans (span_id, trace_id, parent_span_id, session_id, agent_name, operation_name, model, input_tokens, output_tokens, cost_usd, status, error_message, started_at, duration_ms, attributes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                span.span_id.0,
                span.trace_id.0,
                span.parent_span_id.as_ref().map(|s| &s.0),
                span.session_id.0,
                span.agent_name,
                span.operation_name,
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
            .prepare("SELECT span_id, trace_id, parent_span_id, session_id, agent_name, operation_name, model, input_tokens, output_tokens, cost_usd, status, error_message, started_at, duration_ms, attributes FROM spans WHERE session_id = ? ORDER BY started_at ASC")
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

        Ok(Analytics {
            total_sessions: total_sessions as u64,
            total_spans: total_spans as u64,
            total_cost_usd: total_cost,
            ..Default::default()
        })
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
    let model: Option<String> = row.get(6).map_err(|e| GctlError::Storage(e.to_string()))?;
    let input_tokens: i64 = row.get(7).map_err(|e| GctlError::Storage(e.to_string()))?;
    let output_tokens: i64 = row.get(8).map_err(|e| GctlError::Storage(e.to_string()))?;
    let cost_usd: f64 = row.get(9).map_err(|e| GctlError::Storage(e.to_string()))?;
    let status: String = row.get(10).map_err(|e| GctlError::Storage(e.to_string()))?;
    let error_message: Option<String> = row.get(11).map_err(|e| GctlError::Storage(e.to_string()))?;
    let started_at: String = row.get(12).map_err(|e| GctlError::Storage(e.to_string()))?;
    let duration_ms: i64 = row.get(13).map_err(|e| GctlError::Storage(e.to_string()))?;
    let attributes: String = row.get(14).map_err(|e| GctlError::Storage(e.to_string()))?;

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
    fn test_analytics() {
        let store = test_store();
        let mut session = make_session("s1");
        session.total_cost_usd = 1.50;
        store.insert_session(&session).unwrap();
        store.insert_span(&make_span("sp1", "s1")).unwrap();

        let analytics = store.get_analytics().unwrap();
        assert_eq!(analytics.total_sessions, 1);
        assert_eq!(analytics.total_spans, 1);
        assert!((analytics.total_cost_usd - 1.50).abs() < f64::EPSILON);
    }
}
