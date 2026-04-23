use gctrl_core::{AcceptanceCheck, BoardComment, BoardIssue};

/// Build the full brief the agent sees on stdin.
///
/// Layers (concatenated in order):
/// 1. The persona body — freshest `## Agent:` dispatch comment from the
///    board UI, or a minimal fallback if none exists.
/// 2. A `## Acceptance Tests` section (only if `checks` is non-empty)
///    listing each check and the HTTP callback URL the agent must POST
///    results to.
pub fn build_prompt(
    issue: &BoardIssue,
    comments: &[BoardComment],
    checks: &[AcceptanceCheck],
    kernel_base_url: &str,
) -> String {
    let base = latest_dispatch_comment(comments)
        .map(|c| c.body.clone())
        .unwrap_or_else(|| fallback_prompt(issue));
    if checks.is_empty() {
        return base;
    }
    let mut out = base;
    if !out.ends_with("\n\n") {
        if out.ends_with('\n') {
            out.push('\n');
        } else {
            out.push_str("\n\n");
        }
    }
    out.push_str(&render_acceptance_section(issue, checks, kernel_base_url));
    out
}

fn render_acceptance_section(
    issue: &BoardIssue,
    checks: &[AcceptanceCheck],
    kernel_base_url: &str,
) -> String {
    let url = kernel_base_url.trim_end_matches('/');
    let mut s = String::from("## Acceptance Tests\n\n");
    s.push_str(&format!(
        "Run each check below and report the result by POSTing to:\n\
         `{url}/api/board/issues/{id}/acceptance/checks/<IDX>`\n\n\
         Body: `{{\"status\":\"pass\"|\"fail\",\"output\":\"<trimmed stdout/stderr>\"}}`\n\n",
        id = issue.id,
    ));
    for check in checks {
        s.push_str(&format!(
            "- [{idx}] {kind}: {cmd}\n",
            idx = check.idx,
            kind = check.kind.as_str(),
            cmd = check.command,
        ));
    }
    s
}

fn latest_dispatch_comment(comments: &[BoardComment]) -> Option<&BoardComment> {
    comments
        .iter()
        .filter(|c| c.body.contains("## Agent:") || c.author_type == "agent")
        .max_by_key(|c| c.created_at)
}

fn fallback_prompt(issue: &BoardIssue) -> String {
    let desc = issue.description.as_deref().unwrap_or("");
    format!(
        "# {id}: {title}\n\n{desc}\n\n\
         (No dispatch comment on this issue — run the board UI's \
         drag-to-in_progress flow to get a full persona brief, or edit this \
         fallback prompt.)",
        id = issue.id,
        title = issue.title,
        desc = desc,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use gctrl_core::{AcceptanceKind, BoardIssue, IssueStatus};

    fn issue() -> BoardIssue {
        let now = Utc::now();
        BoardIssue {
            id: "BACK-1".into(),
            project_id: "p".into(),
            title: "Fix thing".into(),
            description: Some("describe".into()),
            status: IssueStatus::InProgress,
            priority: "none".into(),
            assignee_id: None,
            assignee_name: None,
            assignee_type: None,
            labels: vec![],
            parent_id: None,
            created_at: now,
            updated_at: now,
            created_by_id: "u".into(),
            created_by_name: "u".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: None,
            source_path: None,
            github_issue_number: None,
            github_url: None,
            start_date: None,
            due_date: None,
            acceptance_criteria: None,
        }
    }

    fn comment(id: &str, body: &str, minutes_ago: i64) -> BoardComment {
        BoardComment {
            id: id.into(),
            issue_id: "BACK-1".into(),
            author_id: "agent-1".into(),
            author_name: "Board".into(),
            author_type: "agent".into(),
            body: body.into(),
            created_at: Utc::now() - Duration::minutes(minutes_ago),
            session_id: None,
        }
    }

    #[test]
    fn picks_latest_dispatch_comment() {
        let comments = vec![
            comment("c1", "## Agent: Engineer\nold brief", 10),
            comment("c2", "## Agent: Engineer\nnew brief", 1),
            comment("c3", "regular human comment", 2),
        ];
        let out = build_prompt(&issue(), &comments, &[], "http://127.0.0.1:4318");
        assert!(out.contains("new brief"), "got: {out}");
        assert!(!out.contains("old brief"));
    }

    #[test]
    fn falls_back_to_title_and_description() {
        let out = build_prompt(&issue(), &[], &[], "http://127.0.0.1:4318");
        assert!(out.contains("BACK-1"));
        assert!(out.contains("Fix thing"));
        assert!(out.contains("describe"));
    }

    #[test]
    fn non_dispatch_comments_ignored() {
        let comments = vec![comment("c1", "human note with no agent header", 1)];
        // author_type=agent means we accept it as a dispatch comment. Use a
        // plain-human comment instead to verify the filter.
        let human = BoardComment {
            author_type: "human".into(),
            ..comments[0].clone()
        };
        let out = build_prompt(&issue(), &[human], &[], "http://127.0.0.1:4318");
        // Should fall back to title/description since no dispatch matches.
        assert!(out.contains("Fix thing"));
        assert!(!out.contains("human note"));
    }

    #[test]
    fn appends_acceptance_section_with_callback_url() {
        let checks = vec![
            AcceptanceCheck {
                idx: 0,
                kind: AcceptanceKind::Shell,
                command: "curl :8080/health → 200".into(),
            },
            AcceptanceCheck {
                idx: 1,
                kind: AcceptanceKind::Test,
                command: "pnpm test foo.test.ts".into(),
            },
        ];
        let out = build_prompt(&issue(), &[], &checks, "http://127.0.0.1:4318");
        assert!(out.contains("## Acceptance Tests"));
        assert!(out.contains("/api/board/issues/BACK-1/acceptance/checks/<IDX>"));
        assert!(out.contains("- [0] shell: curl :8080/health → 200"));
        assert!(out.contains("- [1] test: pnpm test foo.test.ts"));
    }

    #[test]
    fn omits_acceptance_section_when_no_checks() {
        let out = build_prompt(&issue(), &[], &[], "http://127.0.0.1:4318");
        assert!(!out.contains("## Acceptance Tests"));
    }

    #[test]
    fn acceptance_section_follows_dispatch_body() {
        let comments = vec![comment("c1", "## Agent: Engineer\npersona brief body", 1)];
        let checks = vec![AcceptanceCheck {
            idx: 0,
            kind: AcceptanceKind::Shell,
            command: "echo ok".into(),
        }];
        let out = build_prompt(&issue(), &comments, &checks, "http://127.0.0.1:4318");
        let persona_pos = out.find("persona brief body").expect("persona present");
        let acceptance_pos = out.find("## Acceptance Tests").expect("acceptance present");
        assert!(
            persona_pos < acceptance_pos,
            "acceptance must come after persona"
        );
    }

    #[test]
    fn trims_trailing_slash_from_kernel_url() {
        let checks = vec![AcceptanceCheck {
            idx: 0,
            kind: AcceptanceKind::Shell,
            command: "x".into(),
        }];
        let out = build_prompt(&issue(), &[], &checks, "http://127.0.0.1:4318/");
        assert!(out.contains("http://127.0.0.1:4318/api/board/issues/BACK-1"));
        assert!(!out.contains("4318//api"));
    }
}
