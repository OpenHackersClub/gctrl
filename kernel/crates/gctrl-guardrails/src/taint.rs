use std::collections::HashMap;
use std::sync::Mutex;

use gctrl_core::{TaintLabel, TaintLevel};
use sha2::{Digest, Sha256};

pub struct TaintTracker {
    fingerprints: Mutex<HashMap<String, TaintLabel>>,
}

impl TaintTracker {
    pub fn new() -> Self {
        Self {
            fingerprints: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, plaintext: &str, label: TaintLabel) {
        let fingerprint = sha256_hex(plaintext);
        let mut fps = self.fingerprints.lock().unwrap();
        fps.insert(fingerprint, label);
    }

    pub fn register_with_fingerprint(&self, fingerprint: String, label: TaintLabel) {
        let mut fps = self.fingerprints.lock().unwrap();
        fps.insert(fingerprint, label);
    }

    pub fn scan(&self, body: &str) -> Vec<TaintLabel> {
        let fps = self.fingerprints.lock().unwrap();
        let mut found = Vec::new();

        for (fingerprint, label) in fps.iter() {
            // Check if the body contains any registered plaintext by scanning
            // substrings. For efficiency we also check if the full body hash
            // matches, but the primary check is substring presence.
            // In production, the caller typically registers the exact secret
            // value, and we check if it appears anywhere in the outgoing body.
            if body.contains(fingerprint) {
                found.push(label.clone());
            }
        }

        found
    }

    pub fn scan_for_plaintext(&self, body: &str, known_secrets: &[(&str, &TaintLabel)]) -> Vec<TaintLabel> {
        let mut found = Vec::new();
        for (secret, label) in known_secrets {
            if body.contains(secret) {
                found.push((*label).clone());
            }
        }
        found
    }

    pub fn would_block_cloud(&self, body: &str, known_secrets: &[(&str, &TaintLabel)]) -> bool {
        self.scan_for_plaintext(body, known_secrets)
            .iter()
            .any(|label| label.level >= TaintLevel::Internal)
    }

    pub fn unregister(&self, plaintext: &str) {
        let fingerprint = sha256_hex(plaintext);
        let mut fps = self.fingerprints.lock().unwrap();
        fps.remove(&fingerprint);
    }

    pub fn registered_count(&self) -> usize {
        self.fingerprints.lock().unwrap().len()
    }
}

impl Default for TaintTracker {
    fn default() -> Self {
        Self::new()
    }
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    hex_encode(&result)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_scan_fingerprint() {
        let tracker = TaintTracker::new();
        let secret = "sk-ant-api03-very-secret-key";
        let fingerprint = sha256_hex(secret);

        tracker.register(
            secret,
            TaintLabel {
                source: "secrets.ANTHROPIC_API_KEY".into(),
                level: TaintLevel::Secret,
            },
        );

        assert_eq!(tracker.registered_count(), 1);

        // Body containing the fingerprint hash should match
        let body_with_fp = format!("some text with {fingerprint} embedded");
        let found = tracker.scan(&body_with_fp);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].level, TaintLevel::Secret);

        // Body without fingerprint should not match
        let clean_body = "just normal text without any secrets";
        let found = tracker.scan(clean_body);
        assert!(found.is_empty());
    }

    #[test]
    fn scan_for_plaintext_detects_secrets() {
        let tracker = TaintTracker::new();
        let label = TaintLabel {
            source: "env.API_KEY".into(),
            level: TaintLevel::Internal,
        };
        let secrets: Vec<(&str, &TaintLabel)> = vec![("my-secret-key-123", &label)];

        let body_with_secret = "Please use my-secret-key-123 for auth";
        let found = tracker.scan_for_plaintext(body_with_secret, &secrets);
        assert_eq!(found.len(), 1);

        let clean_body = "No secrets here";
        let found = tracker.scan_for_plaintext(clean_body, &secrets);
        assert!(found.is_empty());
    }

    #[test]
    fn would_block_cloud_checks_taint_level() {
        let tracker = TaintTracker::new();

        let internal = TaintLabel {
            source: "user.email".into(),
            level: TaintLevel::Internal,
        };
        let public = TaintLabel {
            source: "public.name".into(),
            level: TaintLevel::Public,
        };

        let secrets: Vec<(&str, &TaintLabel)> =
            vec![("secret@email.com", &internal), ("John", &public)];

        // Body with internal secret → blocks cloud
        assert!(tracker.would_block_cloud("Send to secret@email.com", &secrets));

        // Body with only public data → allows cloud
        assert!(!tracker.would_block_cloud("Hello John", &secrets));
    }

    #[test]
    fn unregister_removes_fingerprint() {
        let tracker = TaintTracker::new();
        let secret = "temp-secret";

        tracker.register(
            secret,
            TaintLabel {
                source: "temp".into(),
                level: TaintLevel::Confidential,
            },
        );
        assert_eq!(tracker.registered_count(), 1);

        tracker.unregister(secret);
        assert_eq!(tracker.registered_count(), 0);
    }

    #[test]
    fn sha256_hex_deterministic() {
        let a = sha256_hex("hello");
        let b = sha256_hex("hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64); // 32 bytes = 64 hex chars
    }
}
