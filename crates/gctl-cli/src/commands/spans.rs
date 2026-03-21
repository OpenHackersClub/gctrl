use anyhow::Result;
use gctl_core::{GctlConfig, SessionId};
use gctl_storage::DuckDbStore;

pub fn run(session_id: &str, format: &str) -> Result<()> {
    let config = GctlConfig::default();
    let store = DuckDbStore::open(&config.storage.db_path.to_string_lossy())?;
    let spans = store.query_spans(&SessionId(session_id.into()))?;

    match format {
        "json" => {
            println!("{}", serde_json::to_string_pretty(&spans)?);
        }
        _ => {
            if spans.is_empty() {
                println!("No spans found for session {session_id}.");
                return Ok(());
            }
            println!(
                "{:<20} {:<25} {:<20} {:>8} {:>8} {:>8}",
                "SPAN_ID", "OPERATION", "MODEL", "IN_TOK", "OUT_TOK", "MS"
            );
            println!("{}", "-".repeat(110));
            for span in &spans {
                println!(
                    "{:<20} {:<25} {:<20} {:>8} {:>8} {:>8}",
                    &span.span_id.0[..span.span_id.0.len().min(20)],
                    &span.operation_name[..span.operation_name.len().min(25)],
                    span.model.as_deref().unwrap_or("-"),
                    span.input_tokens,
                    span.output_tokens,
                    span.duration_ms
                );
            }
        }
    }
    Ok(())
}
