use anyhow::Result;
use gctl_core::{SessionId, SpanType};
use gctl_storage::DuckDbStore;

pub fn run(session_id: &str, db_path: &str) -> Result<()> {
    let store = DuckDbStore::open(db_path)?;

    let session = store.get_session(&SessionId(session_id.into()))?;
    let session = match session {
        Some(s) => s,
        None => {
            println!("Session {session_id} not found.");
            return Ok(());
        }
    };

    let spans = store.query_spans(&SessionId(session_id.into()))?;
    let scores = store.get_scores("session", session_id)?;

    println!("Session: {} \"{}\"", session.id.0, session.agent_name);
    println!(
        "  cost: ${:.4} | tokens: {}in/{}out | spans: {} | status: {}",
        session.total_cost_usd,
        session.total_input_tokens,
        session.total_output_tokens,
        spans.len(),
        session.status.as_str()
    );

    if !scores.is_empty() {
        println!("  scores: {}", scores.iter()
            .map(|s| format!("{}={:.1}", s.name, s.value))
            .collect::<Vec<_>>()
            .join(", "));
    }
    println!();

    // Print root spans (no parent) with children indented
    let root_spans: Vec<_> = spans.iter()
        .filter(|s| s.parent_span_id.is_none())
        .collect();

    for root in &root_spans {
        print_span(root, &spans, 0);
    }

    Ok(())
}

fn print_span(span: &gctl_core::Span, all_spans: &[gctl_core::Span], depth: usize) {
    let indent = "  ".repeat(depth);
    let type_icon = match span.span_type {
        SpanType::Generation => "[gen]",
        SpanType::Span => "[span]",
        SpanType::Event => "[event]",
    };
    let model_str = span.model.as_deref().unwrap_or("");
    let tokens = if span.input_tokens > 0 || span.output_tokens > 0 {
        format!(" {}->{}tok", span.input_tokens, span.output_tokens)
    } else {
        String::new()
    };
    let cost = if span.cost_usd > 0.0 {
        format!(" ${:.4}", span.cost_usd)
    } else {
        String::new()
    };

    println!(
        "{}{} {} {}{}{} {}ms {}",
        indent,
        type_icon,
        span.operation_name,
        model_str,
        tokens,
        cost,
        span.duration_ms,
        span.status.as_str()
    );

    // Print children
    let children: Vec<_> = all_spans.iter()
        .filter(|s| s.parent_span_id.as_ref().map(|p| &p.0) == Some(&span.span_id.0))
        .collect();
    for child in children {
        print_span(child, all_spans, depth + 1);
    }
}
