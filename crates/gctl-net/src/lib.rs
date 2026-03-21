//! Network tools: web crawling, single-page fetch, readability extraction.
//! Phase 2: Will integrate spider crate for crawling.

pub struct FetchResult {
    pub url: String,
    pub status: u16,
    pub body: String,
    pub word_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fetch_result() {
        let result = FetchResult {
            url: "https://example.com".into(),
            status: 200,
            body: "hello world".into(),
            word_count: 2,
        };
        assert_eq!(result.word_count, 2);
    }
}
