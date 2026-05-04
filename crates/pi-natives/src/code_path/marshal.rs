//! Marshal kernel `NodeRef`s into NAPI DTOs with artifact staging.

use std::time::{SystemTime, UNIX_EPOCH};

use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

use crate::code_path::napi::{ContentDto, DiagnosticDto, NodeRefDto, SpanDto};

/// Default artifact staging threshold (~256 KiB).
pub const ARTIFACT_THRESHOLD: usize = 256 * 1024;

/// Convert a batch of kernel `NodeRef`s into DTOs, staging large payloads.
pub fn nodes_to_dtos(nodes: Vec<NodeRef>, threshold: usize) -> Vec<NodeRefDto> {
	nodes.into_iter().map(|n| node_to_dto(n, threshold)).collect()
}

fn node_to_dto(node: NodeRef, threshold: usize) -> NodeRefDto {
	let diagnostics = node.diagnostics.into_iter().map(diagnostic_to_dto).collect();
	NodeRefDto {
		locator:     node.locator,
		range_start: node.range.start as u32,
		range_end:   node.range.end as u32,
		kind:        node.kind,
		content:     node.content.map(|c| content_to_dto(c, threshold)),
		metadata:    serde_json::to_value(node.metadata).unwrap_or(serde_json::Value::Null),
		diagnostics,
	}
}

fn diagnostic_to_dto(d: Diagnostic) -> DiagnosticDto {
	DiagnosticDto {
		variant: diagnostic_variant_to_string(&d.variant),
		message: d.message,
		span:    d.span.map(|s| SpanDto {
			start: s.start as u32,
			end:   s.end as u32,
		}),
	}
}

fn diagnostic_variant_to_string(v: &DiagnosticVariant) -> String {
	match v {
		DiagnosticVariant::ParseError => "parse_error".to_string(),
		DiagnosticVariant::FileNotFound => "file_not_found".to_string(),
		DiagnosticVariant::ArtifactNotFound => "artifact_not_found".to_string(),
		DiagnosticVariant::MemoryPathNotFound => "memory_path_not_found".to_string(),
		DiagnosticVariant::SkillNotFound => "skill_not_found".to_string(),
		DiagnosticVariant::AgentNotFound => "agent_not_found".to_string(),
		DiagnosticVariant::JobNotFound => "job_not_found".to_string(),
		DiagnosticVariant::PiPathNotFound => "pi_path_not_found".to_string(),
		DiagnosticVariant::UnknownLocatorScheme { .. } => "unknown_locator_scheme".to_string(),
		DiagnosticVariant::SuffixSuggestion { .. } => "suffix_suggestion".to_string(),
		DiagnosticVariant::NoMatches => "no_matches".to_string(),
		DiagnosticVariant::AmbiguousTarget { .. } => "ambiguous_target".to_string(),
		DiagnosticVariant::UnsupportedOperation => "unsupported_operation".to_string(),
		DiagnosticVariant::Inaccessible => "inaccessible".to_string(),
		DiagnosticVariant::EncodingFallback => "encoding_fallback".to_string(),
		DiagnosticVariant::Cancelled => "cancelled".to_string(),
	}
}

fn content_to_dto(content: Content, threshold: usize) -> ContentDto {
	match content {
		Content::Text { value } => {
			if value.len() > threshold {
				match stage_artifact(value.as_bytes()) {
					Ok(uri) =>
						ContentDto {
							kind:         "bytes".to_string(),
							artifact_uri: Some(uri),
							size:         Some(value.len() as i64),
							..Default::default()
						},
					Err(_) =>
						ContentDto {
							kind:  "text".to_string(),
							value: Some(value),
							..Default::default()
						},
				}
			} else {
				ContentDto {
					kind:  "text".to_string(),
					value: Some(value),
					..Default::default()
				}
			}
		},
		Content::Bytes { artifact_uri, size } => ContentDto {
			kind:         "bytes".to_string(),
			artifact_uri: Some(artifact_uri),
			size:         Some(size as i64),
			..Default::default()
		},
		Content::Image { handle, mime_type, width, height } => ContentDto {
			kind:      "image".to_string(),
			handle:    Some(handle),
			mime_type: Some(mime_type),
			width,
			height,
			..Default::default()
		},
		Content::ExtractedText { source_kind, text, mime_type } => {
			if text.len() > threshold {
				match stage_artifact(text.as_bytes()) {
					Ok(uri) =>
						ContentDto {
							kind:         "bytes".to_string(),
							artifact_uri: Some(uri),
							size:         Some(text.len() as i64),
							..Default::default()
						},
					Err(_) =>
						ContentDto {
							kind:        "extracted_text".to_string(),
							source_kind: Some(source_kind),
							text:        Some(text),
							mime_type,
							..Default::default()
						},
				}
			} else {
				ContentDto {
					kind:        "extracted_text".to_string(),
					source_kind: Some(source_kind),
					text:        Some(text),
					mime_type,
					..Default::default()
				}
			}
		},
	}
}

fn stage_artifact(bytes: &[u8]) -> std::io::Result<String> {
	let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
	let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
	let dir = std::path::Path::new(&home).join(".spell/agent/blobs/code-path");
	std::fs::create_dir_all(&dir)?;
	let path = dir.join(format!("{}.bin", id));
	std::fs::write(&path, bytes)?;
	Ok(format!("artifact://blobs/code-path/{}.bin", id))
}
