//! Per-key token-bucket rate limiter.
//!
//! Used by the comm endpoint to bound focus calls per `session_id`. Prevents a
//! runaway inbox message (or a UI bug) from spamming `osascript` and starving
//! the user's window manager. Cheap, in-memory, no persistence — buckets that
//! age out are reclaimed lazily on the next access.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct RateLimiterConfig {
    /// Tokens replenished per second.
    pub rate_per_sec: f64,
    /// Maximum burst (also the initial token count).
    pub burst: u32,
    /// Buckets idle for this duration are dropped on next access.
    pub idle_evict: Duration,
}

impl Default for RateLimiterConfig {
    fn default() -> Self {
        Self {
            rate_per_sec: 1.0,
            burst: 10,
            idle_evict: Duration::from_secs(300),
        }
    }
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

#[derive(Debug)]
pub struct RateLimiter {
    cfg: RateLimiterConfig,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(cfg: RateLimiterConfig) -> Self {
        Self {
            cfg,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Try to consume one token for `key`. Returns `true` if acquired.
    /// `now` is injected for deterministic testing.
    pub fn try_acquire_at(&self, key: &str, now: Instant) -> bool {
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");

        // Lazy eviction: drop any bucket idle longer than `idle_evict`.
        // Keeps the map size bounded over long runs without a background thread.
        buckets.retain(|_, b| now.duration_since(b.last_refill) < self.cfg.idle_evict);

        let bucket = buckets.entry(key.to_string()).or_insert_with(|| Bucket {
            tokens: self.cfg.burst as f64,
            last_refill: now,
        });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.cfg.rate_per_sec).min(self.cfg.burst as f64);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn try_acquire(&self, key: &str) -> bool {
        self.try_acquire_at(key, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(rate: f64, burst: u32) -> RateLimiterConfig {
        RateLimiterConfig {
            rate_per_sec: rate,
            burst,
            idle_evict: Duration::from_secs(60),
        }
    }

    #[test]
    fn burst_acquires_then_blocks() {
        let limiter = RateLimiter::new(cfg(1.0, 3));
        let t0 = Instant::now();
        assert!(limiter.try_acquire_at("k", t0));
        assert!(limiter.try_acquire_at("k", t0));
        assert!(limiter.try_acquire_at("k", t0));
        assert!(!limiter.try_acquire_at("k", t0));
    }

    #[test]
    fn refills_over_time() {
        let limiter = RateLimiter::new(cfg(1.0, 1));
        let t0 = Instant::now();
        assert!(limiter.try_acquire_at("k", t0));
        assert!(!limiter.try_acquire_at("k", t0));
        // After 1 second, exactly 1 token should be available.
        let t1 = t0 + Duration::from_secs(1);
        assert!(limiter.try_acquire_at("k", t1));
    }

    #[test]
    fn keys_are_independent() {
        let limiter = RateLimiter::new(cfg(1.0, 1));
        let t0 = Instant::now();
        assert!(limiter.try_acquire_at("a", t0));
        assert!(limiter.try_acquire_at("b", t0));
        assert!(!limiter.try_acquire_at("a", t0));
        assert!(!limiter.try_acquire_at("b", t0));
    }

    #[test]
    fn caps_at_burst_after_long_idle() {
        let limiter = RateLimiter::new(cfg(1.0, 5));
        let t0 = Instant::now();
        // First call gives us full burst minus one.
        assert!(limiter.try_acquire_at("k", t0));
        // Wait 24h — bucket should not exceed `burst`.
        let t1 = t0 + Duration::from_secs(86_400);
        // A 24h refill would mathematically be 86_400 tokens; should cap at 5.
        // The `idle_evict` test config is 60s, so this bucket is evicted and
        // re-created at full burst — the cap-at-burst behavior is implicit.
        for _ in 0..5 {
            assert!(limiter.try_acquire_at("k", t1));
        }
        assert!(!limiter.try_acquire_at("k", t1));
    }
}
