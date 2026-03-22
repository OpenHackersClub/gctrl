use clap::{Parser, Subcommand};
use anyhow::Result;

mod commands;

#[derive(Parser)]
#[command(name = "gctl", version, about = "GroundCtrl — local-first OS for human+agent teams")]
struct Cli {
    /// Path to DuckDB database file (default: ~/.local/share/gctl/gctl.duckdb)
    #[arg(long, global = true)]
    db: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the OTel receiver daemon
    Serve {
        /// Port to listen on
        #[arg(short, long, default_value = "4318")]
        port: u16,
        /// Host to bind to
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },
    /// List recent sessions
    Sessions {
        /// Max sessions to show
        #[arg(short, long, default_value = "20")]
        limit: usize,
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
    },
    /// Show spans for a session
    Spans {
        /// Session ID
        session_id: String,
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
    },
    /// Analytics dashboard and queries
    #[command(subcommand)]
    Analytics(AnalyticsCmd),
    /// Run a named or SQL query
    Query {
        /// Named query (sessions, analytics) or SQL if --raw is set
        query: String,
        /// Allow raw SQL execution
        #[arg(long)]
        raw: bool,
    },
    /// Score a session or span
    Score {
        /// Target type: session, span, generation
        #[arg(long, default_value = "session")]
        target_type: String,
        /// Target ID
        target_id: String,
        /// Score name (e.g. quality, tests_pass)
        #[arg(long)]
        name: String,
        /// Score value (numeric)
        #[arg(long)]
        value: f64,
        /// Optional comment
        #[arg(long)]
        comment: Option<String>,
        /// Score source: human, auto, model
        #[arg(long, default_value = "human")]
        source: String,
    },
    /// Tag a session or span
    Tag {
        /// Target type: session, span
        #[arg(long, default_value = "session")]
        target_type: String,
        /// Target ID
        target_id: String,
        /// Tag key
        #[arg(long)]
        key: String,
        /// Tag value
        #[arg(long)]
        value: String,
    },
    /// Guardrail policy check (for testing)
    Check {
        /// Session ID to check
        session_id: String,
    },
    /// Show status and config
    Status,
    /// Register a prompt version
    Prompt {
        #[command(subcommand)]
        cmd: PromptCmd,
    },
    /// Auto-score a session
    AutoScore {
        /// Session ID
        session_id: String,
    },
    /// Show trace tree for a session
    Tree {
        /// Session ID
        session_id: String,
    },
    /// Manage alert rules
    #[command(subcommand)]
    Alert(AlertCmd),
}

#[derive(Subcommand)]
enum AnalyticsCmd {
    /// Show overview dashboard
    Overview,
    /// Show cost breakdown by model and agent
    Cost,
    /// Show latency percentiles by model
    Latency,
    /// Show score summary
    Scores {
        /// Score name to summarize (e.g. tests_pass, quality)
        name: String,
    },
    /// Show daily aggregate trends
    Daily {
        /// Number of days
        #[arg(short, long, default_value = "7")]
        days: u32,
    },
}

#[derive(Subcommand)]
enum PromptCmd {
    /// Register a prompt file
    Register {
        /// Path to prompt file (e.g. CLAUDE.md)
        file: String,
        /// Version label
        #[arg(long)]
        label: Option<String>,
    },
    /// List registered prompt versions
    List,
}

#[derive(Subcommand)]
enum AlertCmd {
    /// Create an alert rule
    Create {
        /// Rule name
        #[arg(long)]
        name: String,
        /// Condition type: session_cost, error_loop
        #[arg(long)]
        condition: String,
        /// Threshold value
        #[arg(long)]
        threshold: f64,
        /// Action: warn, pause, notify
        #[arg(long, default_value = "warn")]
        action: String,
    },
    /// List alert rules
    List,
}

fn resolve_db_path(db_override: &Option<String>) -> String {
    if let Some(ref db) = db_override {
        db.clone()
    } else {
        let config = gctl_core::GctlConfig::default();
        config.storage.db_path.to_string_lossy().to_string()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let db_path = resolve_db_path(&cli.db);

    match cli.command {
        Commands::Serve { port, host } => commands::serve::run(host, port, &db_path).await,
        Commands::Sessions { limit, format } => commands::sessions::run(limit, &format, &db_path),
        Commands::Spans { session_id, format } => commands::spans::run(&session_id, &format, &db_path),
        Commands::Analytics(cmd) => match cmd {
            AnalyticsCmd::Overview => commands::analytics::run(&db_path),
            AnalyticsCmd::Cost => commands::analytics_cost::run(&db_path),
            AnalyticsCmd::Latency => commands::analytics_latency::run(&db_path),
            AnalyticsCmd::Scores { name } => commands::analytics_scores::run(&name, &db_path),
            AnalyticsCmd::Daily { days } => commands::analytics_daily::run(days, &db_path),
        },
        Commands::Query { query, raw } => commands::query::run(&query, raw, &db_path),
        Commands::Score { target_type, target_id, name, value, comment, source } => {
            commands::score::run(&target_type, &target_id, &name, value, comment.as_deref(), &source, &db_path)
        }
        Commands::Tag { target_type, target_id, key, value } => {
            commands::tag::run(&target_type, &target_id, &key, &value, &db_path)
        }
        Commands::Check { session_id } => commands::check::run(&session_id, &db_path),
        Commands::Status => commands::status::run(),
        Commands::Prompt { cmd } => match cmd {
            PromptCmd::Register { file, label } => commands::prompt::register(&db_path, &file, label.as_deref()),
            PromptCmd::List => commands::prompt::list(&db_path),
        },
        Commands::AutoScore { session_id } => commands::auto_score::run(&session_id, &db_path),
        Commands::Tree { session_id } => commands::trace_tree::run(&session_id, &db_path),
        Commands::Alert(cmd) => match cmd {
            AlertCmd::Create { name, condition, threshold, action } => {
                commands::alert::create(&name, &condition, threshold, &action, &db_path)
            }
            AlertCmd::List => commands::alert::list(&db_path),
        },
    }
}
