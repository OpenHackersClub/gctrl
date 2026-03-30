use gctl_core::{GctlError, Result};
use gctl_storage::DuckDbStore;

pub enum OutputFormat {
    Table,
    Json,
    Csv,
}

pub struct QueryExecutor<'a> {
    store: &'a DuckDbStore,
    allow_raw_sql: bool,
    max_rows: u32,
}

impl<'a> QueryExecutor<'a> {
    pub fn new(store: &'a DuckDbStore, allow_raw_sql: bool, max_rows: u32) -> Self {
        Self {
            store,
            allow_raw_sql,
            max_rows,
        }
    }

    /// Execute a named pre-built query.
    pub fn run_named(&self, name: &str) -> Result<serde_json::Value> {
        match name {
            "sessions" => {
                let sessions = self.store.list_sessions(self.max_rows as usize)?;
                Ok(serde_json::to_value(&sessions)
                    .map_err(|e| GctlError::Query(e.to_string()))?)
            }
            "analytics" => {
                let analytics = self.store.get_analytics()?;
                Ok(serde_json::to_value(&analytics)
                    .map_err(|e| GctlError::Query(e.to_string()))?)
            }
            _ => Err(GctlError::Query(format!("unknown query: {name}"))),
        }
    }

    pub fn is_raw_sql_allowed(&self) -> bool {
        self.allow_raw_sql
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_named_query_sessions() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let executor = QueryExecutor::new(&store, false, 100);
        let result = executor.run_named("sessions").unwrap();
        assert!(result.is_array());
    }

    #[test]
    fn test_named_query_analytics() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let executor = QueryExecutor::new(&store, false, 100);
        let result = executor.run_named("analytics").unwrap();
        assert!(result.is_object());
    }

    #[test]
    fn test_unknown_query() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let executor = QueryExecutor::new(&store, false, 100);
        let result = executor.run_named("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_raw_sql_flag() {
        let store = DuckDbStore::open(":memory:").unwrap();
        let executor = QueryExecutor::new(&store, false, 100);
        assert!(!executor.is_raw_sql_allowed());

        let executor = QueryExecutor::new(&store, true, 100);
        assert!(executor.is_raw_sql_allowed());
    }
}
