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

pub const CREATE_SCORES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS scores (
    id VARCHAR PRIMARY KEY,
    target_type VARCHAR NOT NULL,
    target_id VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    value DOUBLE NOT NULL,
    comment VARCHAR,
    source VARCHAR NOT NULL DEFAULT 'human',
    scored_by VARCHAR,
    created_at VARCHAR NOT NULL
)
"#;

pub const CREATE_TAGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS tags (
    id VARCHAR PRIMARY KEY,
    target_type VARCHAR NOT NULL,
    target_id VARCHAR NOT NULL,
    key VARCHAR NOT NULL,
    value VARCHAR NOT NULL
)
"#;

pub const CREATE_PROMPT_VERSIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS prompt_versions (
    hash VARCHAR PRIMARY KEY,
    content VARCHAR NOT NULL,
    file_path VARCHAR,
    label VARCHAR,
    created_at VARCHAR NOT NULL,
    token_count INTEGER
)
"#;

pub const CREATE_SESSION_PROMPTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session_prompts (
    session_id VARCHAR NOT NULL,
    prompt_hash VARCHAR NOT NULL,
    PRIMARY KEY (session_id, prompt_hash)
)
"#;

pub const CREATE_DAILY_AGGREGATES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS daily_aggregates (
    date VARCHAR NOT NULL,
    metric VARCHAR NOT NULL,
    dimension VARCHAR NOT NULL DEFAULT 'total',
    value DOUBLE NOT NULL,
    PRIMARY KEY (date, metric, dimension)
)
"#;

pub const CREATE_ALERT_RULES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS alert_rules (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    condition_type VARCHAR NOT NULL,
    threshold DOUBLE NOT NULL,
    action VARCHAR NOT NULL DEFAULT 'warn',
    enabled BOOLEAN DEFAULT TRUE
)
"#;

pub const CREATE_ALERT_EVENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS alert_events (
    id VARCHAR PRIMARY KEY,
    rule_id VARCHAR NOT NULL,
    session_id VARCHAR,
    timestamp VARCHAR NOT NULL,
    message VARCHAR NOT NULL,
    acknowledged BOOLEAN DEFAULT FALSE
)
"#;

pub const CREATE_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)",
    "CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic(host)",
    "CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)",
    "CREATE INDEX IF NOT EXISTS idx_scores_target ON scores(target_type, target_id)",
    "CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_type, target_id)",
    "CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key, value)",
    "CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_aggregates(date)",
    "CREATE INDEX IF NOT EXISTS idx_session_prompts ON session_prompts(prompt_hash)",
];

pub fn all_migrations() -> Vec<&'static str> {
    let mut stmts = vec![
        CREATE_SESSIONS_TABLE,
        CREATE_SPANS_TABLE,
        CREATE_TRAFFIC_TABLE,
        CREATE_GUARDRAIL_EVENTS_TABLE,
        CREATE_SCORES_TABLE,
        CREATE_TAGS_TABLE,
        CREATE_PROMPT_VERSIONS_TABLE,
        CREATE_SESSION_PROMPTS_TABLE,
        CREATE_DAILY_AGGREGATES_TABLE,
        CREATE_ALERT_RULES_TABLE,
        CREATE_ALERT_EVENTS_TABLE,
    ];
    stmts.extend(CREATE_INDEXES.iter());
    stmts
}
