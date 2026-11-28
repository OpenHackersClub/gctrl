//! Read-only access to a harness's SQLite store.
//!
//! The database is opened with `mode=ro`. When the harness is not running
//! its WAL index (`-shm`) is absent and a read-only connection cannot create
//! one, so the reader falls back to `immutable=1`; with no `-wal` file
//! present the main file holds every committed write. The driver never
//! writes a harness store.

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub fn open(db: &Path) -> rusqlite::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let base = format!("file:{}", db.display());
    let try_open = |uri: String| -> rusqlite::Result<Connection> {
        let c = Connection::open_with_flags(uri, flags)?;
        c.busy_timeout(std::time::Duration::from_millis(500))?;
        // Opening is lazy; touch the schema so a missing WAL index fails here.
        c.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })?;
        Ok(c)
    };
    try_open(format!("{base}?mode=ro")).or_else(|_| try_open(format!("{base}?immutable=1")))
}

/// Column names of `table`, so a query tolerates older and newer schemas.
pub fn columns(c: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}
