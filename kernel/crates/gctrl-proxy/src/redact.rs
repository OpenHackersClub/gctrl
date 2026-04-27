//! URL redaction — strip sensitive query-string params before persisting.
//! `traffic` table is queryable by any reader of the kernel; we never want
//! `?access_token=…` rows landing there.

use url::Url;

/// Return `url` with any query-string param whose name appears (case-insensitive)
/// in `redact` replaced by `REDACTED`. Falls back to the original string when
/// the URL can't be parsed (e.g. relative paths from CONNECT).
pub fn redact_url(url: &str, redact: &[String]) -> String {
    if redact.is_empty() {
        return url.to_string();
    }
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    let needs_redact = parsed
        .query_pairs()
        .any(|(k, _)| matches_any(&k, redact));
    if !needs_redact {
        return url.to_string();
    }
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| {
            if matches_any(&k, redact) {
                (k.into_owned(), "REDACTED".to_string())
            } else {
                (k.into_owned(), v.into_owned())
            }
        })
        .collect();
    parsed.query_pairs_mut().clear();
    {
        let mut q = parsed.query_pairs_mut();
        for (k, v) in &pairs {
            q.append_pair(k, v);
        }
    }
    parsed.to_string()
}

fn matches_any(key: &str, redact: &[String]) -> bool {
    redact.iter().any(|r| r.eq_ignore_ascii_case(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Vec<String> {
        vec!["access_token".into(), "api_key".into(), "code".into()]
    }

    #[test]
    fn redacts_known_param() {
        let out = redact_url("https://api.example.com/x?api_key=abc&q=hi", &defaults());
        assert!(out.contains("api_key=REDACTED"), "got {out}");
        assert!(out.contains("q=hi"));
    }

    #[test]
    fn case_insensitive_match() {
        let out = redact_url("https://x/y?Access_Token=abc", &defaults());
        assert!(out.contains("Access_Token=REDACTED"));
    }

    #[test]
    fn passthrough_when_no_match() {
        let out = redact_url("https://x/y?q=1", &defaults());
        assert_eq!(out, "https://x/y?q=1");
    }

    #[test]
    fn passthrough_when_unparseable() {
        let out = redact_url("not a url", &defaults());
        assert_eq!(out, "not a url");
    }

    #[test]
    fn empty_redact_list_is_noop() {
        let out = redact_url("https://x/y?api_key=abc", &[]);
        assert_eq!(out, "https://x/y?api_key=abc");
    }
}
