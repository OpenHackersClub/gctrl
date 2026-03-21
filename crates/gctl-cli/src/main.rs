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
    /// Show analytics dashboard
    Analytics,
    /// Run a named or SQL query
    Query {
        /// Named query (sessions, analytics) or SQL if --raw is set
        query: String,
        /// Allow raw SQL execution
        #[arg(long)]
        raw: bool,
    },
    /// Guardrail policy check (for testing)
    Check {
        /// Session ID to check
        session_id: String,
    },
    /// Show status and config
    Status,
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
        Commands::Analytics => commands::analytics::run(&db_path),
        Commands::Query { query, raw } => commands::query::run(&query, raw, &db_path),
        Commands::Check { session_id } => commands::check::run(&session_id, &db_path),
        Commands::Status => commands::status::run(),
    }
}
