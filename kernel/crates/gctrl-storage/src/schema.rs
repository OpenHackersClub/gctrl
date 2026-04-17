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
    span_type       VARCHAR NOT NULL DEFAULT 'span',
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

pub const CREATE_CONTEXT_ENTRIES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS context_entries (
    id              VARCHAR PRIMARY KEY,
    kind            VARCHAR NOT NULL,
    path            VARCHAR NOT NULL UNIQUE,
    title           VARCHAR NOT NULL,
    source_type     VARCHAR NOT NULL,
    source_ref      VARCHAR,
    word_count      INTEGER DEFAULT 0,
    content_hash    VARCHAR NOT NULL,
    tags            JSON DEFAULT '[]',
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
    synced          BOOLEAN DEFAULT FALSE
)
"#;

// --- Board Application Tables (namespaced: board_*) ---

pub const CREATE_BOARD_PROJECTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS board_projects (
    id          VARCHAR PRIMARY KEY,
    name        VARCHAR NOT NULL,
    key         VARCHAR NOT NULL UNIQUE,
    counter     INTEGER DEFAULT 0,
    github_repo VARCHAR
)
"#;

pub const CREATE_BOARD_ISSUES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS board_issues (
    id              VARCHAR PRIMARY KEY,
    project_id      VARCHAR NOT NULL,
    title           VARCHAR NOT NULL,
    description     VARCHAR,
    status          VARCHAR NOT NULL DEFAULT 'backlog',
    priority        VARCHAR NOT NULL DEFAULT 'none',
    assignee_id     VARCHAR,
    assignee_name   VARCHAR,
    assignee_type   VARCHAR,
    labels          JSON DEFAULT '[]',
    parent_id       VARCHAR,
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
    created_by_id   VARCHAR NOT NULL,
    created_by_name VARCHAR NOT NULL,
    created_by_type VARCHAR NOT NULL,
    blocked_by      JSON DEFAULT '[]',
    blocking        JSON DEFAULT '[]',
    session_ids     JSON DEFAULT '[]',
    total_cost_usd  DOUBLE DEFAULT 0.0,
    total_tokens    BIGINT DEFAULT 0,
    pr_numbers      JSON DEFAULT '[]',
    content_hash    VARCHAR,
    source_path     VARCHAR,
    github_issue_number INTEGER,
    github_url      VARCHAR
)
"#;

pub const CREATE_BOARD_EVENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS board_events (
    id          VARCHAR PRIMARY KEY,
    issue_id    VARCHAR NOT NULL,
    type        VARCHAR NOT NULL,
    actor_id    VARCHAR NOT NULL,
    actor_name  VARCHAR NOT NULL,
    actor_type  VARCHAR NOT NULL,
    timestamp   VARCHAR NOT NULL,
    data        JSON
)
"#;

pub const CREATE_BOARD_COMMENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS board_comments (
    id          VARCHAR PRIMARY KEY,
    issue_id    VARCHAR NOT NULL,
    author_id   VARCHAR NOT NULL,
    author_name VARCHAR NOT NULL,
    author_type VARCHAR NOT NULL,
    body        VARCHAR NOT NULL,
    created_at  VARCHAR NOT NULL,
    session_id  VARCHAR
)
"#;

// --- Persona Tables (kernel extension, persona_* prefix) ---

pub const CREATE_PERSONA_DEFINITIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS persona_definitions (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    focus           VARCHAR NOT NULL,
    prompt_prefix   VARCHAR NOT NULL,
    owns            VARCHAR NOT NULL,
    review_focus    VARCHAR NOT NULL,
    pushes_back     VARCHAR NOT NULL,
    tools           JSON DEFAULT '[]',
    key_specs       JSON DEFAULT '[]',
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL,
    source_hash     VARCHAR
)
"#;

pub const CREATE_PERSONA_REVIEW_RULES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS persona_review_rules (
    id              VARCHAR PRIMARY KEY,
    pr_type         VARCHAR NOT NULL UNIQUE,
    persona_ids     JSON NOT NULL,
    created_at      VARCHAR NOT NULL
)
"#;

// --- Inbox Application Tables (namespaced: inbox_*) ---

pub const CREATE_INBOX_MESSAGES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_messages (
    id              VARCHAR PRIMARY KEY,
    thread_id       VARCHAR NOT NULL,
    source          VARCHAR NOT NULL,
    kind            VARCHAR NOT NULL,
    urgency         VARCHAR NOT NULL DEFAULT 'medium',
    title           VARCHAR NOT NULL,
    body            VARCHAR,
    context         JSON NOT NULL DEFAULT '{}',
    status          VARCHAR NOT NULL DEFAULT 'pending',
    requires_action BOOLEAN NOT NULL DEFAULT false,
    payload         JSON,
    duplicate_count INTEGER DEFAULT 0,
    snoozed_until   VARCHAR,
    expires_at      VARCHAR,
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL
)
"#;

pub const CREATE_INBOX_THREADS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_threads (
    id              VARCHAR PRIMARY KEY,
    context_type    VARCHAR NOT NULL,
    context_ref     VARCHAR NOT NULL,
    title           VARCHAR NOT NULL,
    project_key     VARCHAR,
    pending_count   INTEGER DEFAULT 0,
    latest_urgency  VARCHAR DEFAULT 'info',
    created_at      VARCHAR NOT NULL,
    updated_at      VARCHAR NOT NULL
)
"#;

pub const CREATE_INBOX_ACTIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_actions (
    id              VARCHAR PRIMARY KEY,
    message_id      VARCHAR NOT NULL,
    thread_id       VARCHAR NOT NULL,
    actor_id        VARCHAR NOT NULL,
    actor_name      VARCHAR NOT NULL,
    action_type     VARCHAR NOT NULL,
    reason          VARCHAR,
    metadata        JSON,
    created_at      VARCHAR NOT NULL
)
"#;

pub const CREATE_INBOX_SUBSCRIPTIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS inbox_subscriptions (
    id              VARCHAR PRIMARY KEY,
    user_id         VARCHAR NOT NULL,
    filter_type     VARCHAR NOT NULL,
    filter_value    VARCHAR NOT NULL,
    enabled         BOOLEAN DEFAULT true,
    created_at      VARCHAR NOT NULL
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
    "CREATE INDEX IF NOT EXISTS idx_context_kind ON context_entries(kind)",
    "CREATE INDEX IF NOT EXISTS idx_context_source ON context_entries(source_type)",
    "CREATE INDEX IF NOT EXISTS idx_context_path ON context_entries(path)",
    "CREATE INDEX IF NOT EXISTS idx_context_synced ON context_entries(synced)",
    // Board indexes
    "CREATE INDEX IF NOT EXISTS idx_board_issues_project ON board_issues(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_status ON board_issues(status)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_assignee ON board_issues(assignee_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_issues_parent ON board_issues(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_events_issue ON board_events(issue_id)",
    "CREATE INDEX IF NOT EXISTS idx_board_comments_issue ON board_comments(issue_id)",
    // Persona indexes
    "CREATE INDEX IF NOT EXISTS idx_persona_definitions_name ON persona_definitions(name)",
    "CREATE INDEX IF NOT EXISTS idx_persona_review_rules_type ON persona_review_rules(pr_type)",
    // Inbox indexes
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread ON inbox_messages(thread_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_urgency ON inbox_messages(urgency)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_messages_kind ON inbox_messages(kind)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_threads_context ON inbox_threads(context_type, context_ref)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_threads_project ON inbox_threads(project_key)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_actions_message ON inbox_actions(message_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_actions_actor ON inbox_actions(actor_id)",
    "CREATE INDEX IF NOT EXISTS idx_inbox_subscriptions_user ON inbox_subscriptions(user_id)",
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
        CREATE_CONTEXT_ENTRIES_TABLE,
        CREATE_BOARD_PROJECTS_TABLE,
        CREATE_BOARD_ISSUES_TABLE,
        CREATE_BOARD_EVENTS_TABLE,
        CREATE_BOARD_COMMENTS_TABLE,
        CREATE_PERSONA_DEFINITIONS_TABLE,
        CREATE_PERSONA_REVIEW_RULES_TABLE,
        CREATE_INBOX_MESSAGES_TABLE,
        CREATE_INBOX_THREADS_TABLE,
        CREATE_INBOX_ACTIONS_TABLE,
        CREATE_INBOX_SUBSCRIPTIONS_TABLE,
    ];
    stmts.extend(CREATE_INDEXES.iter());
    stmts
}
