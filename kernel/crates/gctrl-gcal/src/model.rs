use serde::{Deserialize, Serialize};

/// Subset of `calendars#resource` we surface upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calendar {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "timeZone")]
    pub time_zone: Option<String>,
    #[serde(default, rename = "accessRole")]
    pub access_role: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
}

/// Google represents `start`/`end` as either `dateTime` (RFC 3339, with `timeZone`)
/// or `date` (YYYY-MM-DD, all-day). We preserve both forms verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventDateTime {
    #[serde(default, rename = "dateTime", skip_serializing_if = "Option::is_none")]
    pub date_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, rename = "timeZone", skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub id: String,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub start: Option<EventDateTime>,
    #[serde(default)]
    pub end: Option<EventDateTime>,
    #[serde(default, rename = "htmlLink")]
    pub html_link: Option<String>,
    #[serde(default, rename = "iCalUID")]
    pub ical_uid: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Vec<String>>,
    #[serde(default)]
    pub created: Option<String>,
    #[serde(default)]
    pub updated: Option<String>,
}

/// Body for create + patch. Only fields the user can actually change in v1.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<EventDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<EventDateTime>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EventList {
    #[serde(default)]
    pub items: Vec<CalendarEvent>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CalendarList {
    #[serde(default)]
    pub items: Vec<Calendar>,
}
