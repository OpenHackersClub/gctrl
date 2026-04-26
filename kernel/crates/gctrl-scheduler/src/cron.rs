//! Cron expression parsing + next-fire computation.
//!
//! The upstream `cron` crate uses 6- or 7-field expressions (with leading
//! seconds and optional trailing year). Standard Unix cron is 5 fields. We
//! accept either and normalise to 6 by prepending `0` for the seconds field
//! when needed, so users can write `0 */2 * * *` and get the obvious
//! "every 2 hours on the hour" behaviour.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use cron::Schedule as CronExpr;

#[derive(Debug, thiserror::Error)]
pub enum CronError {
    #[error("cron expression must have 5, 6 or 7 fields, got {0}")]
    BadFieldCount(usize),
    #[error("invalid cron expression: {0}")]
    Parse(String),
}

/// Parse a 5/6/7-field cron expression into the upstream type. 5-field input
/// is normalised by prepending a `0` seconds field.
pub fn parse(input: &str) -> Result<CronExpr, CronError> {
    let trimmed = input.trim();
    let n = trimmed.split_whitespace().count();
    let normalised = match n {
        5 => format!("0 {}", trimmed),
        6 | 7 => trimmed.to_string(),
        other => return Err(CronError::BadFieldCount(other)),
    };
    CronExpr::from_str(&normalised).map_err(|e| CronError::Parse(e.to_string()))
}

/// Compute the next fire time strictly after `after`. Returns `None` if the
/// cron has no future occurrences in the supported range (cron crate caps at
/// year 2100).
pub fn next_after(input: &str, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, CronError> {
    let expr = parse(input)?;
    Ok(expr.after(&after).next())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn five_field_every_two_hours() {
        let now = Utc.with_ymd_and_hms(2026, 4, 26, 1, 30, 0).unwrap();
        let next = next_after("0 */2 * * *", now).unwrap().unwrap();
        // Next *:00 hour that is even after 01:30 is 02:00.
        assert_eq!(next.hour(), 2);
        assert_eq!(next.minute(), 0);
    }

    #[test]
    fn six_field_passes_through() {
        let now = Utc.with_ymd_and_hms(2026, 4, 26, 12, 0, 0).unwrap();
        // every minute on second :00
        let next = next_after("0 * * * * *", now).unwrap().unwrap();
        assert!(next > now);
        assert_eq!(next.second(), 0);
    }

    #[test]
    fn rejects_bad_field_count() {
        assert!(matches!(parse("* * *"), Err(CronError::BadFieldCount(3))));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(parse("not a cron"), Err(CronError::BadFieldCount(_))));
        assert!(matches!(parse("xyz abc def ghi jkl"), Err(CronError::Parse(_))));
    }
}
