//! Marshal kernel `NodeRef`s into NAPI DTOs with artifact staging.

use std::time::{SystemTime, UNIX_EPOCH};

use pi_code_path::{
	ast::MutationOutcome,
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

use crate::code_path::napi::{ContentDto, DiagnosticDto, NodeRefDto, SpanDto};

/// Default artifact staging threshold (~256 KiB).
pub const ARTIFACT_THRESHOLD: usize = 256 * 1024;

/// Convert a batch of kernel `NodeRef`s into DTOs, staging large payloads.
/// Convert a `MutationOutcome` into a single `NodeRefDto` with kind
/// `§edit-result`.
pub fn mutation_outcome_to_dto(outcome: MutationOutcome) -> NodeRefDto {
	let mut metadata = serde_json::Map::new();
	metadata.insert("editCount".into(), serde_json::json!(outcome.edit_count));
	if let Some(diff) = &outcome.diff {
		metadata.insert("diff".into(), serde_json::json!(diff));
	}
	metadata.insert("created".into(), serde_json::json!(outcome.created));
	if let Some(summary) = &outcome.target_summary {
		metadata.insert("targetSummary".into(), serde_json::json!(summary));
	}
	NodeRefDto {
		locator:     "edit".to_string(),
		range_start: 0,
		range_end:   0,
		kind:        "§edit-result".to_string(),
		content:     None,
		metadata:    serde_json::Value::Object(metadata),
		diagnostics: Vec::new(),
	}
}

pub fn nodes_to_dtos(nodes: Vec<NodeRef>, threshold: usize) -> Vec<NodeRefDto> {
	nodes
		.into_iter()
		.map(|n| node_to_dto(n, threshold))
		.collect()
}

fn node_to_dto(node: NodeRef, threshold: usize) -> NodeRefDto {
	let diagnostics = node
		.diagnostics
		.into_iter()
		.map(diagnostic_to_dto)
		.collect();
	NodeRefDto {
		locator: node.locator,
		range_start: node.range.start as u32,
		range_end: node.range.end as u32,
		kind: node.kind,
		content: node.content.map(|c| content_to_dto(c, threshold)),
		metadata: serde_json::to_value(node.metadata).unwrap_or(serde_json::Value::Null),
		diagnostics,
	}
}

pub fn diagnostic_to_dto(d: Diagnostic) -> DiagnosticDto {
	DiagnosticDto {
		variant: diagnostic_variant_to_string(&d.variant),
		message: d.message,
		span:    d
			.span
			.map(|s| SpanDto { start: s.start as u32, end: s.end as u32 }),
	}
}

pub fn diagnostic_variant_to_string(v: &DiagnosticVariant) -> String {
	match v {
		DiagnosticVariant::ParseError => "parse_error".to_string(),
		DiagnosticVariant::FileNotFound => "file_not_found".to_string(),
		DiagnosticVariant::ArtifactNotFound => "artifact_not_found".to_string(),

		DiagnosticVariant::UnknownLocatorScheme { .. } => "unknown_locator_scheme".to_string(),
		DiagnosticVariant::SuffixSuggestion { .. } => "suffix_suggestion".to_string(),
		DiagnosticVariant::NoMatches => "no_matches".to_string(),
		DiagnosticVariant::AmbiguousTarget { .. } => "ambiguous_target".to_string(),
		DiagnosticVariant::UnsupportedOperation => "unsupported_operation".to_string(),
		DiagnosticVariant::Inaccessible => "inaccessible".to_string(),
		DiagnosticVariant::EncodingFallback => "encoding_fallback".to_string(),
		DiagnosticVariant::SchemeNotImplemented => "scheme_not_implemented".to_string(),
		DiagnosticVariant::FileExists => "file_exists".to_string(),
		DiagnosticVariant::StaleAnchor => "stale_anchor".to_string(),
		DiagnosticVariant::Cancelled => "cancelled".to_string(),
		DiagnosticVariant::MissingActions => "missing_actions".to_string(),
		DiagnosticVariant::ZeroByteDeleteBlocked => "zero_byte_delete_blocked".to_string(),
		DiagnosticVariant::UnsupportedActionForResolver => {
			"unsupported_action_for_resolver".to_string()
		},
		DiagnosticVariant::RangeBoundsInverted => "range_bounds_inverted".to_string(),
		DiagnosticVariant::RangeClamped => "range_clamped".to_string(),
		DiagnosticVariant::IncompatibleTargetShape => "incompatible_target_shape".to_string(),
	}
}

fn content_to_dto(content: Content, threshold: usize) -> ContentDto {
	match content {
		Content::Text { value } => {
			if value.len() > threshold {
				match stage_artifact(value.as_bytes()) {
					Ok(uri) => ContentDto {
						kind: "bytes".to_string(),
						artifact_uri: Some(uri),
						size: Some(value.len() as i64),
						..Default::default()
					},
					Err(_) => {
						ContentDto { kind: "text".to_string(), value: Some(value), ..Default::default() }
					},
				}
			} else {
				ContentDto { kind: "text".to_string(), value: Some(value), ..Default::default() }
			}
		},
		Content::Bytes { artifact_uri, size } => ContentDto {
			kind: "bytes".to_string(),
			artifact_uri: Some(artifact_uri),
			size: Some(size as i64),
			..Default::default()
		},
		Content::Image { handle, mime_type, width, height, bytes } => {
			if let Some(b) = bytes {
				match sniff_image_mime(&b) {
					Some(actual_mime) => {
						let value = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b);
						ContentDto {
							kind: "image".to_string(),
							value: Some(value),
							mime_type: Some(actual_mime.to_string()),
							width,
							height,
							..Default::default()
						}
					}
					None => {
						// Bytes aren't a transportable raster image (PNG/JPEG/GIF/WebP).
						// If valid UTF-8 (SVG, ASCII art, etc.) preserve content as text so the
						// model can still reason about it. Otherwise emit a hex diagnostic.
						match std::str::from_utf8(&b) {
							Ok(text) => ContentDto {
								kind: "extracted_text".to_string(),
								value: Some(text.to_string()),
								mime_type: Some(mime_type),
								source_kind: Some("image".to_string()),
								width,
								height,
								..Default::default()
							},
							Err(_) => {
								let preview: String = b.iter().take(8).map(|byte| format!("{:02x}", byte)).collect::<Vec<_>>().join(" ");
								ContentDto {
									kind: "extracted_text".to_string(),
									value: Some(format!(
										"[not an image: declared {}, bytes start with {}]",
										mime_type, preview
									)),
									source_kind: Some("image".to_string()),
									..Default::default()
								}
							}
						}
					}
				}
			} else {
				ContentDto {
					kind: "image".to_string(),
					mime_type: Some(mime_type),
					width,
					height,
					handle: Some(handle),
					..Default::default()
				}
			}
		},
		Content::ExtractedText { source_kind, text, mime_type } => {
			if text.len() > threshold {
				match stage_artifact(text.as_bytes()) {
					Ok(uri) => ContentDto {
						kind: "bytes".to_string(),
						artifact_uri: Some(uri),
						size: Some(text.len() as i64),
						..Default::default()
					},
					Err(_) => ContentDto {
						kind: "extracted_text".to_string(),
						source_kind: Some(source_kind),
						text: Some(text),
						mime_type,
						..Default::default()
					},
				}
			} else {
				ContentDto {
					kind: "extracted_text".to_string(),
						source_kind: Some(source_kind),
						text: Some(text),
						mime_type,
						..Default::default()
					}
				}
			},
		}
	}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
	if bytes.len() >= 8 && bytes[0..8] == [137, 80, 78, 71, 13, 10, 26, 10] {
		return Some("image/png");
	}
	if bytes.len() >= 3 && bytes[0..3] == [255, 216, 255] {
		return Some("image/jpeg");
	}
	if bytes.len() >= 4 && bytes[0..4] == [71, 73, 70, 56] {
		return Some("image/gif");
	}
	if bytes.len() >= 12
		&& bytes[0..4] == [82, 73, 70, 70]
		&& bytes[8..12] == [87, 69, 66, 80]
	{
		return Some("image/webp");
	}
	None
}

fn stage_artifact(bytes: &[u8]) -> std::io::Result<String> {
	let id = format!(
		"{:x}",
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos()
	);
	let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
	let dir = std::path::Path::new(&home).join(".spell/agent/blobs/code-path");
	std::fs::create_dir_all(&dir)?;
	let path = dir.join(format!("{}.bin", id));
	std::fs::write(&path, bytes)?;
	Ok(format!("artifact://blobs/code-path/{}.bin", id))
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;

	fn text_node(value: String) -> NodeRef {
		NodeRef {
			locator:     "test".to_string(),
			range:       0..0,
			kind:        "test".to_string(),
			content:     Some(Content::Text { value }),
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		}
	}

	#[test]
	fn default_threshold_externalises_large_text() {
		let node = text_node("x".repeat(256 * 1024 + 1));
		let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
		assert_eq!(dtos.len(), 1);
		let c = dtos[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for content > 256 KiB");
		assert!(c.value.is_none(), "expected no inline value");
	}

	#[test]
	fn low_threshold_externalises_text() {
		let node = text_node("x".repeat(1025));
		let dtos = nodes_to_dtos(vec![node], 1024);
		assert_eq!(dtos.len(), 1);
		let c = dtos[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for content > 1 KiB");
		assert!(c.value.is_none());
	}

	#[test]
	fn zero_threshold_externalises_everything() {
		let node = text_node("x".to_string());
		let dtos = nodes_to_dtos(vec![node], 0);
		assert_eq!(dtos.len(), 1);
		let c = dtos[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for zero threshold");
		assert!(c.value.is_none());
	}

	#[test]
	fn max_threshold_inlines_everything() {
		let node = text_node("x".repeat(256 * 1024 + 1));
		let dtos = nodes_to_dtos(vec![node], u32::MAX as usize);
		assert_eq!(dtos.len(), 1);
		let c = dtos[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_none(), "expected no artifact_uri for huge threshold");
		assert!(c.value.is_some(), "expected inline value");
	}

fn image_node(handle: &str, mime_type: &str, width: Option<u32>, height: Option<u32>, bytes: Option<Vec<u8>>) -> NodeRef {
	NodeRef {
		locator: "test".to_string(),
		range: 0..0,
		kind: "test".to_string(),
		content: Some(Content::Image {
			handle: handle.to_string(),
			mime_type: mime_type.to_string(),
			width,
			height,
			bytes,
		}),
		metadata: HashMap::new(),
		diagnostics: Vec::new(),
	}
}

#[test]
fn image_bytes_returned_inline_even_when_oversized() {
	let png_header: Vec<u8> = vec![137, 80, 78, 71, 13, 10, 26, 10];
	let mut bytes = png_header;
	bytes.extend(vec![0u8; ARTIFACT_THRESHOLD + 1024]);
	let node = image_node("h", "image/png", None, None, Some(bytes));
	let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
	assert_eq!(dtos.len(), 1);
	let c = dtos[0].content.as_ref().expect("content expected");
	assert_eq!(c.kind, "image", "expected image kind");
	assert!(c.value.is_some(), "expected inline base64 value");
	assert!(c.artifact_uri.is_none(), "expected no artifact_uri");
	assert_eq!(c.mime_type.as_deref(), Some("image/png"));
}

#[test]
fn image_with_utf8_bytes_preserves_text() {
	// Non-image but valid UTF-8 (e.g. JSON saved with .png extension, SVG, ASCII
	// art) is preserved verbatim as `extracted_text` so the model can still read
	// it. The previous behavior dropped content for a hex diagnostic; this avoids
	// the lossy substitution while still keeping it out of the image transport
	// path (BUG-378).
	let bytes = b"{\"format\":\"png\"}".to_vec();
	let node = image_node("h", "image/png", None, None, Some(bytes.clone()));
	let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
	assert_eq!(dtos.len(), 1);
	let c = dtos[0].content.as_ref().expect("content expected");
	assert_eq!(c.kind, "extracted_text", "expected extracted_text kind");
	assert_eq!(c.source_kind.as_deref(), Some("image"));
	assert_eq!(c.mime_type.as_deref(), Some("image/png"));
	let val = c.value.as_ref().expect("expected value");
	assert_eq!(val, &String::from_utf8(bytes).unwrap(), "text bytes preserved verbatim");
}

#[test]
fn image_with_non_utf8_bytes_emits_diagnostic() {
	// Bytes that are neither a recognized image format nor valid UTF-8 (e.g.
	// random binary in a .png file) fall back to a hex preview diagnostic so the
	// model knows something exists at this path but cannot be processed.
	let bytes = vec![0x00, 0xC0, 0xFF, 0xEE, 0xDE, 0xAD, 0xBE, 0xEF, 0xFF];
	let node = image_node("h", "image/png", None, None, Some(bytes));
	let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
	assert_eq!(dtos.len(), 1);
	let c = dtos[0].content.as_ref().expect("content expected");
	assert_eq!(c.kind, "extracted_text");
	let val = c.value.as_ref().expect("expected value");
	assert!(val.contains("[not an image:"), "missing diagnostic prefix: {val}");
	assert!(val.contains("image/png"), "missing declared mime in diagnostic: {val}");
}

#[test]
fn image_mime_corrected_from_bytes() {
	let bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01];
	let node = image_node("h", "image/png", None, None, Some(bytes));
	let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
	assert_eq!(dtos.len(), 1);
	let c = dtos[0].content.as_ref().expect("content expected");
	assert_eq!(c.kind, "image", "expected image kind");
	assert_eq!(c.mime_type.as_deref(), Some("image/jpeg"), "sniffer should detect JPEG magic over declared png");
}
}
