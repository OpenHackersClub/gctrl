//! `gctl board` commands — project management and kanban.

use anyhow::Result;
use gctl_storage::DuckDbStore;

fn open_store(db_path: &str) -> Result<DuckDbStore> {
    Ok(DuckDbStore::open(db_path)?)
}

/// Create a new project.
pub fn create_project(name: &str, key: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let project = gctl_core::BoardProject {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        key: key.to_uppercase(),
        counter: 0,
    };
    store.create_board_project(&project)?;
    println!("Created project: {} ({})", project.name, project.key);
    Ok(())
}

/// List projects.
pub fn list_projects(format: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let projects = store.list_board_projects()?;

    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&projects)?);
        return Ok(());
    }

    if projects.is_empty() {
        println!("No projects. Use `gctl board create-project <name> <key>` to get started.");
        return Ok(());
    }

    println!("{:<36} {:<20} {:<6} {:>5}", "ID", "NAME", "KEY", "COUNT");
    println!("{}", "-".repeat(70));
    for p in &projects {
        println!("{:<36} {:<20} {:<6} {:>5}", p.id, p.name, p.key, p.counter);
    }
    Ok(())
}

/// Create a new issue.
pub fn create_issue(
    project_key: &str,
    title: &str,
    description: Option<&str>,
    priority: &str,
    labels: Option<&str>,
    created_by: &str,
    db_path: &str,
) -> Result<()> {
    let store = open_store(db_path)?;

    // Find project by key
    let projects = store.list_board_projects()?;
    let project = projects
        .iter()
        .find(|p| p.key == project_key.to_uppercase())
        .ok_or_else(|| anyhow::anyhow!("project not found: {}", project_key))?;

    let counter = store.increment_project_counter(&project.id)?;
    let now = chrono::Utc::now();
    let labels_vec: Vec<String> = labels
        .map(|l| l.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let issue = gctl_core::BoardIssue {
        id: format!("{}-{}", project.key, counter),
        project_id: project.id.clone(),
        title: title.to_string(),
        description: description.map(String::from),
        status: gctl_core::IssueStatus::Backlog,
        priority: priority.to_string(),
        assignee_id: None,
        assignee_name: None,
        assignee_type: None,
        labels: labels_vec,
        parent_id: None,
        created_at: now,
        updated_at: now,
        created_by_id: created_by.to_string(),
        created_by_name: created_by.to_string(),
        created_by_type: "human".to_string(),
        blocked_by: vec![],
        blocking: vec![],
        session_ids: vec![],
        total_cost_usd: 0.0,
        total_tokens: 0,
        pr_numbers: vec![],
    };

    store.insert_board_issue(&issue)?;
    println!("{} — {}", issue.id, issue.title);
    Ok(())
}

/// List issues with optional filters.
pub fn list_issues(
    project: Option<&str>,
    status: Option<&str>,
    assignee: Option<&str>,
    format: &str,
    db_path: &str,
) -> Result<()> {
    let store = open_store(db_path)?;

    // Resolve project key to ID if provided
    let project_id = if let Some(key) = project {
        let projects = store.list_board_projects()?;
        projects.iter()
            .find(|p| p.key == key.to_uppercase())
            .map(|p| p.id.clone())
    } else {
        None
    };

    let filter = gctl_core::BoardIssueFilter {
        project_id,
        status: status.map(String::from),
        assignee_id: assignee.map(String::from),
        ..Default::default()
    };

    let issues = store.list_board_issues(&filter)?;

    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&issues)?);
        return Ok(());
    }

    if issues.is_empty() {
        println!("No issues found.");
        return Ok(());
    }

    println!("{:<12} {:<12} {:<30} {:<10} {:>8}", "ID", "STATUS", "TITLE", "ASSIGNEE", "COST");
    println!("{}", "-".repeat(76));
    for issue in &issues {
        let assignee = issue.assignee_name.as_deref().unwrap_or("-");
        let title = if issue.title.len() > 28 {
            format!("{}…", &issue.title[..27])
        } else {
            issue.title.clone()
        };
        println!(
            "{:<12} {:<12} {:<30} {:<10} ${:>7.2}",
            issue.id, issue.status.as_str(), title, assignee, issue.total_cost_usd,
        );
    }
    println!("\n{} issues", issues.len());
    Ok(())
}

/// Show a single issue with details.
pub fn show_issue(issue_id: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let issue = store
        .get_board_issue(issue_id)?
        .ok_or_else(|| anyhow::anyhow!("issue not found: {}", issue_id))?;

    println!("{} — {}", issue.id, issue.title);
    println!("Status:   {}", issue.status.as_str());
    println!("Priority: {}", issue.priority);
    if let Some(ref name) = issue.assignee_name {
        println!("Assignee: {} ({})", name, issue.assignee_type.as_deref().unwrap_or("?"));
    }
    if !issue.labels.is_empty() {
        println!("Labels:   {}", issue.labels.join(", "));
    }
    if let Some(ref desc) = issue.description {
        println!("\n{}", desc);
    }
    if !issue.blocked_by.is_empty() {
        println!("\nBlocked by: {}", issue.blocked_by.join(", "));
    }
    if !issue.session_ids.is_empty() {
        println!("\nSessions: {} (${:.2}, {} tokens)", issue.session_ids.len(), issue.total_cost_usd, issue.total_tokens);
    }

    // Show events
    let events = store.list_board_events(&issue.id)?;
    if !events.is_empty() {
        println!("\nEvents:");
        for event in &events {
            println!("  {} — {} by {}", event.event_type, event.timestamp.format("%Y-%m-%d %H:%M"), event.actor_name);
        }
    }

    // Show comments
    let comments = store.list_board_comments(&issue.id)?;
    if !comments.is_empty() {
        println!("\nComments:");
        for comment in &comments {
            println!("  {} ({}): {}", comment.author_name, comment.created_at.format("%Y-%m-%d %H:%M"), comment.body);
        }
    }

    Ok(())
}

/// Move an issue to a new status.
pub fn move_issue(issue_id: &str, status: &str, actor: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    store.update_board_issue_status(issue_id, status, actor, actor, "human")?;
    println!("{} → {}", issue_id, status);
    Ok(())
}

/// Assign an issue.
pub fn assign_issue(issue_id: &str, assignee_name: &str, assignee_type: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let assignee_id = assignee_name.to_lowercase().replace(' ', "-");
    store.assign_board_issue(issue_id, &assignee_id, assignee_name, assignee_type)?;
    println!("{} → assigned to {} ({})", issue_id, assignee_name, assignee_type);
    Ok(())
}

/// Add a comment to an issue.
pub fn comment(issue_id: &str, body: &str, author: &str, db_path: &str) -> Result<()> {
    let store = open_store(db_path)?;
    let comment = gctl_core::BoardComment {
        id: uuid::Uuid::new_v4().to_string(),
        issue_id: issue_id.to_string(),
        author_id: author.to_string(),
        author_name: author.to_string(),
        author_type: "human".to_string(),
        body: body.to_string(),
        created_at: chrono::Utc::now(),
        session_id: None,
    };
    store.insert_board_comment(&comment)?;
    println!("Comment added to {}", issue_id);
    Ok(())
}
