pub const CREATE_SESSIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR PRIMARY KEY,
    workspace_id    VARCHAR NOT NULL,
    device_id       VARCHAR NOT NULL,
    agent_name      VARCHAR NOT NULL,
    started_at      VARCHAR NOT NULL,
    ended_at        VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'active',
    total_cost_usd  DOUBLE DEFAULT 0.0,
    total_input_tokens  BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    synced          BOOLEAN DEFAULT FALSE
)
"#;

pub const CREATE_SPANS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS spans (
    span_id         VARCHAR PRIMARY KEY,
    trace_id        VARCHAR NOT NULL,
    parent_span_id  VARCHAR,
    session_id      VARCHAR NOT NULL,
    agent_name      VARCHAR NOT NULL,
    operation_name  VARCHAR NOT NULL,
    model           VARCHAR,
    input_tokens    BIGINT DEFAULT 0,
    output_tokens   BIGINT DEFAULT 0,
    cost_usd        DOUBLE DEFAULT 0.0,
    status          VARCHAR NOT NULL DEFAULT 'unset',
    error_message   VARCHAR,
    started_at      VARCHAR NOT NULL,
    duration_ms     BIGINT NOT NULL,
    attributes      JSON,
    synced          BOOLEAN DEFAULT FALSE
)
"#;

pub const CREATE_TRAFFIC_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS traffic (
    id              VARCHAR PRIMARY KEY,
    timestamp       VARCHAR NOT NULL,
    method          VARCHAR NOT NULL,
    url             VARCHAR NOT NULL,
    host            VARCHAR NOT NULL,
    status_code     SMALLINT NOT NULL,
    request_size    BIGINT DEFAULT 0,
    response_size   BIGINT DEFAULT 0,
    duration_ms     BIGINT NOT NULL,
    session_id      VARCHAR,
    synced          BOOLEAN DEFAULT FALSE
)
"#;

pub const CREATE_GUARDRAIL_EVENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS guardrail_events (
    id              VARCHAR PRIMARY KEY,
    timestamp       VARCHAR NOT NULL,
    session_id      VARCHAR,
    policy_name     VARCHAR NOT NULL,
    decision        VARCHAR NOT NULL,
    reason          VARCHAR,
    context         JSON
)
"#;

pub const CREATE_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)",
    "CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic(host)",
    "CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)",
];

pub fn all_migrations() -> Vec<&'static str> {
    let mut stmts = vec![
        CREATE_SESSIONS_TABLE,
        CREATE_SPANS_TABLE,
        CREATE_TRAFFIC_TABLE,
        CREATE_GUARDRAIL_EVENTS_TABLE,
    ];
    stmts.extend(CREATE_INDEXES.iter());
    stmts
}
