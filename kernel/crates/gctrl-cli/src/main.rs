use clap::{Parser, Subcommand};
use anyhow::Result;

mod commands;

#[derive(Parser)]
#[command(name = "gctrld", version, about = "GroundCtrl kernel daemon — local-first OS for human+agent teams")]
struct Cli {
    /// Path to DuckDB database file (default: ~/.local/share/gctrl/gctrl.duckdb)
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
        /// Board markdown directory to watch for auto-import (e.g. gctrl/)
        #[arg(long)]
        board_dir: Option<String>,
        /// Disable board directory file watcher
        #[arg(long, default_value = "false")]
        no_watch: bool,
    },
    /// List recent sessions
    Sessions {
        /// Max sessions to show
        #[arg(short, long, default_value = "20")]
        limit: usize,
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
        /// Filter by agent name
        #[arg(short, long)]
        agent: Option<String>,
        /// Filter by status (active, completed, failed, cancelled)
        #[arg(short = 'S', long)]
        status: Option<String>,
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
    /// Web scraping and agent-optimized context
    #[command(subcommand)]
    Net(NetCmd),
    /// Manage agent context (docs, configs, snapshots)
    #[command(subcommand)]
    Context(ContextCmd),
    /// Project management and kanban
    #[command(subcommand)]
    Board(BoardCmd),
    /// Import persona definitions from a markdown vault
    #[command(subcommand)]
    Personas(PersonasCmd),
    /// Orchestrator — spawn agents for dispatch-eligible tasks
    #[command(subcommand)]
    Orch(OrchCmd),
}

#[derive(Subcommand)]
enum PersonasCmd {
    /// Import personas and review rules from a vault directory
    Import {
        /// Vault directory (default: gctrl/personas)
        #[arg(long, default_value = "gctrl/personas")]
        dir: String,
    },
    /// List personas and review rules currently in the store
    List,
}

#[derive(Subcommand)]
enum OrchCmd {
    /// Run the worker loop (default: forever, polling every --interval s)
    Run {
        /// Do one drain pass then exit (instead of looping)
        #[arg(long)]
        once: bool,
        /// Poll interval in seconds
        #[arg(long, default_value = "5")]
        interval: u64,
        /// Max tasks to dispatch per drain pass
        #[arg(long = "max-per-pass", alias = "max-concurrent", default_value = "1")]
        max_per_pass: usize,
        /// Hard timeout for one agent run, in seconds
        #[arg(long, default_value = "1800")]
        timeout: u64,
        /// Agent command (program + args). Prompt is sent on stdin.
        #[arg(long, default_values_t = vec!["claude".to_string(), "-p".to_string()])]
        agent: Vec<String>,
        /// Working directory for the agent (default: current dir)
        #[arg(long)]
        working_dir: Option<std::path::PathBuf>,
        /// Don't spawn anything — log what would happen, then release the claim
        #[arg(long)]
        dry_run: bool,
    },
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
    /// Show span type distribution (Generation/Span/Event)
    Spans,
    /// Show per-model cost breakdown for a session
    CostBreakdown {
        /// Session ID
        session_id: String,
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
enum NetCmd {
    /// Fetch a single URL and convert to markdown
    Fetch {
        /// URL to fetch
        url: String,
        /// Disable readability extraction
        #[arg(long)]
        no_readability: bool,
        /// Minimum word count to accept
        #[arg(long, default_value = "50")]
        min_words: usize,
    },
    /// Crawl a website and save pages as markdown
    Crawl {
        /// URL to start crawling from
        url: String,
        /// Maximum crawl depth
        #[arg(short, long, default_value = "3")]
        depth: usize,
        /// Maximum pages to crawl
        #[arg(long, default_value = "50")]
        max_pages: usize,
        /// Delay between requests in ms
        #[arg(long, default_value = "200")]
        delay: u64,
        /// Disable readability extraction
        #[arg(long)]
        no_readability: bool,
        /// Minimum word count to keep a page
        #[arg(long, default_value = "50")]
        min_words: usize,
    },
    /// List all crawled sites
    List,
    /// Show crawled content for a domain
    Show {
        /// Domain name (e.g. docs.example.com)
        domain: String,
        /// Specific page file to display
        #[arg(long)]
        page: Option<String>,
    },
    /// Compact pages into a single agent-optimized context file
    Compact {
        /// Domain name
        domain: String,
        /// Output format: gitingest (single file) or index (table)
        #[arg(long, default_value = "gitingest")]
        format: String,
        /// Output directory (prints to stdout if not set)
        #[arg(short, long)]
        output: Option<String>,
    },
    /// Show crawl statistics for a domain
    Stats {
        /// Domain name (e.g. docs.example.com)
        domain: String,
    },
}

#[derive(Subcommand)]
enum ContextCmd {
    /// Add a file as a context entry
    Add {
        /// Path to local file to add
        file: String,
        /// Store path (e.g. runbooks/deploy.md). Defaults to filename.
        #[arg(long, alias = "as")]
        path: Option<String>,
        /// Context kind: config, snapshot, document
        #[arg(long, default_value = "document")]
        kind: String,
        /// Tags (comma-separated)
        #[arg(long)]
        tags: Option<String>,
    },
    /// List context entries
    List {
        /// Filter by kind (config, snapshot, document)
        #[arg(long)]
        kind: Option<String>,
        /// Filter by tag
        #[arg(long)]
        tag: Option<String>,
        /// Search title/path
        #[arg(long)]
        search: Option<String>,
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
    },
    /// Show a context entry's content
    Show {
        /// Entry ID or path
        entry: String,
    },
    /// Remove a context entry
    Remove {
        /// Entry ID or path
        entry: String,
    },
    /// Compact context into a single LLM-ready document
    Compact {
        /// Filter by kind
        #[arg(long)]
        kind: Option<String>,
        /// Filter by tag
        #[arg(long)]
        tag: Option<String>,
        /// Output file (stdout if not set)
        #[arg(short, long)]
        output: Option<String>,
    },
    /// Show context store statistics
    Stats,
    /// Import crawled content from gctrl-net as context entries
    Import {
        /// Domain to import (e.g. docs.example.com)
        domain: String,
    },
}

#[derive(Subcommand)]
enum BoardCmd {
    /// Create a project
    CreateProject {
        /// Project name
        name: String,
        /// Project key (e.g. BACK, FRONT)
        key: String,
    },
    /// List projects
    Projects {
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
    },
    /// Create an issue
    Create {
        /// Project key (e.g. BACK)
        project: String,
        /// Issue title
        title: String,
        /// Description
        #[arg(long)]
        description: Option<String>,
        /// Priority: urgent, high, medium, low, none
        #[arg(long, default_value = "none")]
        priority: String,
        /// Labels (comma-separated)
        #[arg(long)]
        labels: Option<String>,
        /// Creator name
        #[arg(long, default_value = "human")]
        by: String,
    },
    /// List issues
    List {
        /// Filter by project key
        #[arg(long)]
        project: Option<String>,
        /// Filter by status
        #[arg(long)]
        status: Option<String>,
        /// Filter by assignee
        #[arg(long)]
        assignee: Option<String>,
        /// Output format: table, json
        #[arg(short, long, default_value = "table")]
        format: String,
    },
    /// Show issue details
    Show {
        /// Issue ID (e.g. BACK-1)
        id: String,
    },
    /// Move issue to a new status
    Move {
        /// Issue ID
        id: String,
        /// Target status: backlog, todo, in_progress, in_review, done, cancelled
        status: String,
        /// Actor name
        #[arg(long, default_value = "human")]
        by: String,
    },
    /// Assign issue to a person or agent
    Assign {
        /// Issue ID
        id: String,
        /// Assignee name
        name: String,
        /// Assignee type: human, agent
        #[arg(long, default_value = "human")]
        r#type: String,
    },
    /// Add a comment
    Comment {
        /// Issue ID
        id: String,
        /// Comment body
        body: String,
        /// Author name
        #[arg(long, default_value = "human")]
        by: String,
    },
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
        let config = gctrl_core::GctlConfig::default();
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
        Commands::Serve { port, host, board_dir, no_watch } => {
            let dir = if no_watch {
                None
            } else {
                board_dir
                    .map(std::path::PathBuf::from)
                    .or_else(|| {
                        // Auto-detect: if ./gctrl/ exists, watch it
                        let default = std::path::PathBuf::from("gctrl");
                        if default.is_dir() { Some(default) } else { None }
                    })
                    .and_then(|p| p.canonicalize().ok())
            };
            commands::serve::run(host, port, &db_path, dir).await
        }
        Commands::Sessions { limit, format, agent, status } => commands::sessions::run(limit, &format, agent.as_deref(), status.as_deref(), &db_path),
        Commands::Spans { session_id, format } => commands::spans::run(&session_id, &format, &db_path),
        Commands::Analytics(cmd) => match cmd {
            AnalyticsCmd::Overview => commands::analytics::run(&db_path),
            AnalyticsCmd::Cost => commands::analytics_cost::run(&db_path),
            AnalyticsCmd::Latency => commands::analytics_latency::run(&db_path),
            AnalyticsCmd::Scores { name } => commands::analytics_scores::run(&name, &db_path),
            AnalyticsCmd::Daily { days } => commands::analytics_daily::run(days, &db_path),
            AnalyticsCmd::Spans => commands::analytics_spans::run(&db_path),
            AnalyticsCmd::CostBreakdown { session_id } => commands::analytics_cost_breakdown::run(&session_id, &db_path),
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
        Commands::Context(cmd) => match cmd {
            ContextCmd::Add { file, path, kind, tags } => {
                commands::context::add(&file, path.as_deref(), &kind, tags.as_deref(), &db_path)
            }
            ContextCmd::List { kind, tag, search, format } => {
                commands::context::list(kind.as_deref(), tag.as_deref(), search.as_deref(), &format, &db_path)
            }
            ContextCmd::Show { entry } => commands::context::show(&entry, &db_path),
            ContextCmd::Remove { entry } => commands::context::remove(&entry, &db_path),
            ContextCmd::Compact { kind, tag, output } => {
                commands::context::compact(kind.as_deref(), tag.as_deref(), output.as_deref(), &db_path)
            }
            ContextCmd::Stats => commands::context::stats(&db_path),
            ContextCmd::Import { domain } => commands::context::import_crawl(&domain, &db_path),
        },
        Commands::Board(cmd) => match cmd {
            BoardCmd::CreateProject { name, key } => {
                commands::board::create_project(&name, &key, &db_path)
            }
            BoardCmd::Projects { format } => commands::board::list_projects(&format, &db_path),
            BoardCmd::Create { project, title, description, priority, labels, by } => {
                commands::board::create_issue(&project, &title, description.as_deref(), &priority, labels.as_deref(), &by, &db_path)
            }
            BoardCmd::List { project, status, assignee, format } => {
                commands::board::list_issues(project.as_deref(), status.as_deref(), assignee.as_deref(), &format, &db_path)
            }
            BoardCmd::Show { id } => commands::board::show_issue(&id, &db_path),
            BoardCmd::Move { id, status, by } => commands::board::move_issue(&id, &status, &by, &db_path),
            BoardCmd::Assign { id, name, r#type } => {
                commands::board::assign_issue(&id, &name, &r#type, &db_path)
            }
            BoardCmd::Comment { id, body, by } => commands::board::comment(&id, &body, &by, &db_path),
        },
        Commands::Personas(cmd) => match cmd {
            PersonasCmd::Import { dir } => commands::personas::import(std::path::Path::new(&dir), &db_path),
            PersonasCmd::List => commands::personas::list(&db_path),
        },
        Commands::Orch(cmd) => match cmd {
            OrchCmd::Run { once, interval, max_per_pass, timeout, agent, working_dir, dry_run } => {
                commands::orch::run(&db_path, once, interval, max_per_pass, timeout, agent, working_dir, dry_run).await
            }
        },
        Commands::Net(cmd) => match cmd {
            NetCmd::Fetch { url, no_readability, min_words } => {
                commands::net::fetch(&url, no_readability, min_words).await
            }
            NetCmd::Crawl { url, depth, max_pages, delay, no_readability, min_words } => {
                commands::net::crawl(&url, depth, max_pages, delay, no_readability, min_words).await
            }
            NetCmd::List => commands::net::list(),
            NetCmd::Show { domain, page } => commands::net::show(&domain, page.as_deref()),
            NetCmd::Compact { domain, format, output } => {
                commands::net::compact(&domain, &format, output.as_deref())
            }
            NetCmd::Stats { domain } => commands::net::stats(&domain),
        },
    }
}
