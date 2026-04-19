use gctrl_core::{BoardComment, BoardIssue};

/// Pick the freshest dispatch comment posted by gctrl-board when the Issue
/// moved to `in_progress`. The board UI posts them with a distinctive
/// `## Agent:` section — we key off that so regular chat comments don't
/// get mistaken for an agent brief.
///
/// Falls back to building a minimal prompt from title+description if no
/// dispatch comment is found — lets `gctrld board move ... in_progress`
/// work even without a persona match.
pub fn build_prompt(issue: &BoardIssue, comments: &[BoardComment]) -> String {
    if let Some(dispatch) = latest_dispatch_comment(comments) {
        return dispatch.body.clone();
    }
    fallback_prompt(issue)
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
    use gctrl_core::{BoardIssue, IssueStatus};

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
        let out = build_prompt(&issue(), &comments);
        assert!(out.contains("new brief"), "got: {out}");
        assert!(!out.contains("old brief"));
    }

    #[test]
    fn falls_back_to_title_and_description() {
        let out = build_prompt(&issue(), &[]);
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
        let out = build_prompt(&issue(), &[human]);
        // Should fall back to title/description since no dispatch matches.
        assert!(out.contains("Fix thing"));
        assert!(!out.contains("human note"));
    }
}
