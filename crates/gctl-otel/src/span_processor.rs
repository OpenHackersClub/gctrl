use chrono::{DateTime, TimeZone, Utc};
use gctl_core::{Span, SpanId, SpanStatus, SessionId, TraceId};
use serde::Deserialize;

/// Simplified OTLP JSON span representation.
/// Full protobuf support is a Phase 2 item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpExportRequest {
    #[serde(default)]
    pub resource_spans: Vec<ResourceSpans>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSpans {
    #[serde(default)]
    pub resource: Option<OtlpResource>,
    #[serde(default)]
    pub scope_spans: Vec<ScopeSpans>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpResource {
    #[serde(default)]
    pub attributes: Vec<OtlpKeyValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSpans {
    #[serde(default)]
    pub spans: Vec<OtlpSpan>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpSpan {
    pub trace_id: String,
    pub span_id: String,
    #[serde(default)]
    pub parent_span_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub start_time_unix_nano: u64,
    #[serde(default)]
    pub end_time_unix_nano: u64,
    #[serde(default)]
    pub attributes: Vec<OtlpKeyValue>,
    #[serde(default)]
    pub status: Option<OtlpStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpKeyValue {
    pub key: String,
    #[serde(default)]
    pub value: Option<OtlpAnyValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpAnyValue {
    #[serde(default)]
    pub string_value: Option<String>,
    #[serde(default)]
    pub int_value: Option<i64>,
    #[serde(default)]
    pub double_value: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpStatus {
    #[serde(default)]
    pub code: u32,
    #[serde(default)]
    pub message: Option<String>,
}

impl OtlpKeyValue {
    pub fn string_val(&self) -> Option<&str> {
        self.value.as_ref()?.string_value.as_deref()
    }

    pub fn int_val(&self) -> Option<i64> {
        self.value.as_ref()?.int_value
    }

    pub fn double_val(&self) -> Option<f64> {
        self.value.as_ref()?.double_value
    }
}

fn find_attr<'a>(attrs: &'a [OtlpKeyValue], key: &str) -> Option<&'a OtlpKeyValue> {
    attrs.iter().find(|a| a.key == key)
}

fn nanos_to_datetime(nanos: u64) -> DateTime<Utc> {
    let secs = (nanos / 1_000_000_000) as i64;
    let nsecs = (nanos % 1_000_000_000) as u32;
    Utc.timestamp_opt(secs, nsecs).unwrap()
}

/// Convert an OTLP export request into internal Span types.
pub fn process_export_request(req: &OtlpExportRequest) -> Vec<Span> {
    let mut spans = Vec::new();

    for rs in &req.resource_spans {
        let resource_attrs = rs
            .resource
            .as_ref()
            .map(|r| &r.attributes[..])
            .unwrap_or(&[]);

        let session_id = find_attr(resource_attrs, "session.id")
            .and_then(|a| a.string_val())
            .unwrap_or("unknown")
            .to_string();

        let agent_name = find_attr(resource_attrs, "service.name")
            .and_then(|a| a.string_val())
            .unwrap_or("unknown")
            .to_string();

        for ss in &rs.scope_spans {
            for otlp_span in &ss.spans {
                let model = find_attr(&otlp_span.attributes, "ai.model.id")
                    .or_else(|| find_attr(&otlp_span.attributes, "gen_ai.request.model"))
                    .and_then(|a| a.string_val())
                    .map(String::from);

                let input_tokens = find_attr(&otlp_span.attributes, "ai.tokens.input")
                    .or_else(|| find_attr(&otlp_span.attributes, "gen_ai.usage.prompt_tokens"))
                    .and_then(|a| a.int_val())
                    .unwrap_or(0) as u64;

                let output_tokens = find_attr(&otlp_span.attributes, "ai.tokens.output")
                    .or_else(|| find_attr(&otlp_span.attributes, "gen_ai.usage.completion_tokens"))
                    .and_then(|a| a.int_val())
                    .unwrap_or(0) as u64;

                let cost_usd = find_attr(&otlp_span.attributes, "ai.cost.usd")
                    .and_then(|a| a.double_val())
                    .unwrap_or(0.0);

                let started_at = nanos_to_datetime(otlp_span.start_time_unix_nano);
                let duration_ms = if otlp_span.end_time_unix_nano > otlp_span.start_time_unix_nano {
                    (otlp_span.end_time_unix_nano - otlp_span.start_time_unix_nano) / 1_000_000
                } else {
                    0
                };

                let status = match otlp_span.status.as_ref().map(|s| s.code) {
                    Some(2) => SpanStatus::Error(
                        otlp_span
                            .status
                            .as_ref()
                            .and_then(|s| s.message.clone())
                            .unwrap_or_default(),
                    ),
                    Some(1) => SpanStatus::Ok,
                    _ => SpanStatus::Unset,
                };

                // Build attributes JSON from remaining OTLP attributes
                let attrs: serde_json::Map<String, serde_json::Value> = otlp_span
                    .attributes
                    .iter()
                    .filter_map(|kv| {
                        let val = kv.value.as_ref()?;
                        let json_val = if let Some(ref s) = val.string_value {
                            serde_json::Value::String(s.clone())
                        } else if let Some(i) = val.int_value {
                            serde_json::Value::Number(i.into())
                        } else if let Some(f) = val.double_value {
                            serde_json::Number::from_f64(f)
                                .map(serde_json::Value::Number)
                                .unwrap_or(serde_json::Value::Null)
                        } else {
                            return None;
                        };
                        Some((kv.key.clone(), json_val))
                    })
                    .collect();

                spans.push(Span {
                    span_id: SpanId(otlp_span.span_id.clone()),
                    trace_id: TraceId(otlp_span.trace_id.clone()),
                    parent_span_id: otlp_span.parent_span_id.clone().map(SpanId),
                    session_id: SessionId(session_id.clone()),
                    agent_name: agent_name.clone(),
                    operation_name: otlp_span.name.clone(),
                    model,
                    input_tokens,
                    output_tokens,
                    cost_usd,
                    status,
                    started_at,
                    duration_ms,
                    attributes: serde_json::Value::Object(attrs),
                });
            }
        }
    }

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_export_request() -> OtlpExportRequest {
        OtlpExportRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(OtlpResource {
                    attributes: vec![
                        OtlpKeyValue {
                            key: "session.id".into(),
                            value: Some(OtlpAnyValue {
                                string_value: Some("sess-123".into()),
                                int_value: None,
                                double_value: None,
                            }),
                        },
                        OtlpKeyValue {
                            key: "service.name".into(),
                            value: Some(OtlpAnyValue {
                                string_value: Some("claude-code".into()),
                                int_value: None,
                                double_value: None,
                            }),
                        },
                    ],
                }),
                scope_spans: vec![ScopeSpans {
                    spans: vec![OtlpSpan {
                        trace_id: "t1".into(),
                        span_id: "s1".into(),
                        parent_span_id: None,
                        name: "llm.call".into(),
                        start_time_unix_nano: 1_700_000_000_000_000_000,
                        end_time_unix_nano: 1_700_000_002_000_000_000,
                        attributes: vec![
                            OtlpKeyValue {
                                key: "ai.model.id".into(),
                                value: Some(OtlpAnyValue {
                                    string_value: Some("claude-opus-4-6".into()),
                                    int_value: None,
                                    double_value: None,
                                }),
                            },
                            OtlpKeyValue {
                                key: "ai.tokens.input".into(),
                                value: Some(OtlpAnyValue {
                                    string_value: None,
                                    int_value: Some(1500),
                                    double_value: None,
                                }),
                            },
                            OtlpKeyValue {
                                key: "ai.tokens.output".into(),
                                value: Some(OtlpAnyValue {
                                    string_value: None,
                                    int_value: Some(800),
                                    double_value: None,
                                }),
                            },
                            OtlpKeyValue {
                                key: "ai.cost.usd".into(),
                                value: Some(OtlpAnyValue {
                                    string_value: None,
                                    int_value: None,
                                    double_value: Some(0.12),
                                }),
                            },
                        ],
                        status: Some(OtlpStatus {
                            code: 1,
                            message: None,
                        }),
                    }],
                }],
            }],
        }
    }

    #[test]
    fn test_process_export_request() {
        let req = make_export_request();
        let spans = process_export_request(&req);

        assert_eq!(spans.len(), 1);
        let span = &spans[0];
        assert_eq!(span.session_id.0, "sess-123");
        assert_eq!(span.agent_name, "claude-code");
        assert_eq!(span.operation_name, "llm.call");
        assert_eq!(span.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(span.input_tokens, 1500);
        assert_eq!(span.output_tokens, 800);
        assert!((span.cost_usd - 0.12).abs() < f64::EPSILON);
        assert_eq!(span.duration_ms, 2000);
        assert_eq!(span.status, SpanStatus::Ok);
    }

    #[test]
    fn test_empty_export_request() {
        let req = OtlpExportRequest {
            resource_spans: vec![],
        };
        let spans = process_export_request(&req);
        assert!(spans.is_empty());
    }

    #[test]
    fn test_missing_optional_attributes() {
        let req = OtlpExportRequest {
            resource_spans: vec![ResourceSpans {
                resource: None,
                scope_spans: vec![ScopeSpans {
                    spans: vec![OtlpSpan {
                        trace_id: "t1".into(),
                        span_id: "s1".into(),
                        parent_span_id: None,
                        name: "tool.call".into(),
                        start_time_unix_nano: 1_700_000_000_000_000_000,
                        end_time_unix_nano: 1_700_000_001_000_000_000,
                        attributes: vec![],
                        status: None,
                    }],
                }],
            }],
        };
        let spans = process_export_request(&req);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].session_id.0, "unknown");
        assert_eq!(spans[0].agent_name, "unknown");
        assert!(spans[0].model.is_none());
        assert_eq!(spans[0].input_tokens, 0);
        assert_eq!(spans[0].status, SpanStatus::Unset);
    }

    #[test]
    fn test_nanos_to_datetime() {
        let dt = nanos_to_datetime(1_700_000_000_000_000_000);
        assert_eq!(dt.timestamp(), 1_700_000_000);
    }
}
