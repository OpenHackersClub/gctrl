use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::SessionId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaintLevel {
    Public = 0,
    Internal = 1,
    Confidential = 2,
    Secret = 3,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaintLabel {
    pub source: String,
    pub level: TaintLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedProvenance {
    pub created_at: DateTime<Utc>,
    pub created_by: String,
    pub session_id: Option<SessionId>,
}

/// Runtime taint wrapper for sensitive data. Analogous to TACIT's Classified[T].
///
/// The inner value can only be accessed through `declassify()` which requires
/// a `DeclassificationAuthority` that only the kernel can construct.
///
/// Deliberately does NOT implement Debug, Display, Serialize, or Clone — this
/// prevents accidental leakage through logging, serialization, or copying.
pub struct Classified<T> {
    value: T,
    taint: TaintLabel,
    provenance: ClassifiedProvenance,
}

impl<T> Classified<T> {
    pub(crate) fn new(value: T, taint: TaintLabel, provenance: ClassifiedProvenance) -> Self {
        Self {
            value,
            taint,
            provenance,
        }
    }

    /// Apply a pure function to the classified value. The result inherits the taint.
    ///
    /// Uses a function pointer (`fn`) instead of a closure (`impl Fn`) to enforce
    /// local purity: function pointers cannot capture any environment, preventing
    /// side-channel exfiltration of the inner value through mutable captures.
    /// This is the Rust equivalent of TACIT's `T -> U` (pure) vs `T => U` (impure).
    pub fn map_pure<U>(&self, f: fn(&T) -> U) -> Classified<U> {
        Classified {
            value: f(&self.value),
            taint: self.taint.clone(),
            provenance: self.provenance.clone(),
        }
    }

    pub fn taint(&self) -> &TaintLabel {
        &self.taint
    }

    pub fn provenance(&self) -> &ClassifiedProvenance {
        &self.provenance
    }

    pub fn declassify(&self, _auth: &DeclassificationAuthority) -> &T {
        &self.value
    }

    pub fn into_declassified(self, _auth: &DeclassificationAuthority) -> T {
        self.value
    }
}

impl<T, U> Classified<(T, U)> {
    pub fn unzip(self) -> (Classified<T>, Classified<U>) {
        let taint = self.taint.clone();
        let provenance = self.provenance.clone();
        let (a, b) = self.value;
        (
            Classified {
                value: a,
                taint: taint.clone(),
                provenance: provenance.clone(),
            },
            Classified {
                value: b,
                taint,
                provenance,
            },
        )
    }
}

/// Authority required to unwrap classified data. Only the kernel can construct this.
pub struct DeclassificationAuthority {
    _private: (),
}

impl DeclassificationAuthority {
    pub(crate) fn new() -> Self {
        Self { _private: () }
    }
}

/// Combine the taint of two labels, taking the higher level.
pub fn combine_taint(a: &TaintLabel, b: &TaintLabel) -> TaintLabel {
    TaintLabel {
        source: format!("{}+{}", a.source, b.source),
        level: a.level.max(b.level),
    }
}

/// Classify a value with the given taint label. Kernel-only entry point.
pub(crate) fn classify<T>(value: T, taint: TaintLabel, created_by: &str) -> Classified<T> {
    Classified::new(
        value,
        taint,
        ClassifiedProvenance {
            created_at: Utc::now(),
            created_by: created_by.to_string(),
            session_id: None,
        },
    )
}

/// Classify a value within a session context. Kernel-only entry point.
pub(crate) fn classify_in_session<T>(
    value: T,
    taint: TaintLabel,
    created_by: &str,
    session_id: SessionId,
) -> Classified<T> {
    Classified::new(
        value,
        taint,
        ClassifiedProvenance {
            created_at: Utc::now(),
            created_by: created_by.to_string(),
            session_id: Some(session_id),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taint_level_ordering() {
        assert!(TaintLevel::Public < TaintLevel::Internal);
        assert!(TaintLevel::Internal < TaintLevel::Confidential);
        assert!(TaintLevel::Confidential < TaintLevel::Secret);
    }

    fn to_uppercase(s: &String) -> String {
        s.to_uppercase()
    }

    #[test]
    fn classified_map_pure_propagates_taint() {
        let secret = classify(
            "api-key-123".to_string(),
            TaintLabel {
                source: "secrets.API_KEY".into(),
                level: TaintLevel::Secret,
            },
            "test",
        );

        let upper = secret.map_pure(to_uppercase);
        assert_eq!(upper.taint().level, TaintLevel::Secret);
        assert_eq!(upper.taint().source, "secrets.API_KEY");
    }

    #[test]
    fn classified_declassify_requires_authority() {
        let secret = classify(
            42u64,
            TaintLabel {
                source: "test".into(),
                level: TaintLevel::Confidential,
            },
            "test",
        );

        let auth = DeclassificationAuthority::new();
        assert_eq!(*secret.declassify(&auth), 42u64);
    }

    #[test]
    fn combine_taint_takes_max_level() {
        let a = TaintLabel {
            source: "a".into(),
            level: TaintLevel::Internal,
        };
        let b = TaintLabel {
            source: "b".into(),
            level: TaintLevel::Secret,
        };
        let combined = combine_taint(&a, &b);
        assert_eq!(combined.level, TaintLevel::Secret);
        assert_eq!(combined.source, "a+b");
    }

    #[test]
    fn classified_into_declassified() {
        let secret = classify(
            vec![1, 2, 3],
            TaintLabel {
                source: "data".into(),
                level: TaintLevel::Internal,
            },
            "test",
        );

        let auth = DeclassificationAuthority::new();
        let value = secret.into_declassified(&auth);
        assert_eq!(value, vec![1, 2, 3]);
    }
}
