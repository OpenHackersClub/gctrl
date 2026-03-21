use clap::{Parser, Subcommand};
use anyhow::Result;

mod commands;

#[derive(Parser)]
#[command(name = "gctl", version, about = "GroundCtrl — local-first OS for human+agent teams")]
struct Cli {
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Serve { port, host } => commands::serve::run(host, port).await,
        Commands::Sessions { limit, format } => commands::sessions::run(limit, &format),
        Commands::Spans { session_id, format } => commands::spans::run(&session_id, &format),
        Commands::Analytics => commands::analytics::run(),
        Commands::Query { query, raw } => commands::query::run(&query, raw),
        Commands::Check { session_id } => commands::check::run(&session_id),
        Commands::Status => commands::status::run(),
    }
}
