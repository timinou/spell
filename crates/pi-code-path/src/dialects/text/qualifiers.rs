//! Qualifier resolution for the text dialect.
//!
//! `#raw`, `#bytes`, `#text`, `#match`, `#captures[N]`, `#lines[a..b]`,
//! `#image`, `#thumbnail[N]`.

use std::{collections::HashMap, sync::Arc};

use super::axes::line_steps;
use crate::{
	ast::{Axis, Head, Predicate, Qualifier, Step},
	resolver::traits::FormatExtractor,
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

/// Resolve a text-dialect qualifier against `node`.
pub fn resolve_qualifier(
	node: &NodeRef,
	content: &[u8],
	qual: &Qualifier,
	extractors: &[Arc<dyn FormatExtractor>],
) -> Result<NodeRef, Diagnostic> {
	match qual.name.as_str() {
		"raw" => resolve_raw(node, content),
		"bytes" => resolve_bytes(node, content),
		"text" => resolve_text(node, content, extractors),
		"match" => resolve_match(node, content),
		"captures" => resolve_captures(node, qual.args.as_deref()),
		"lines" => resolve_lines(node, content, qual.args.as_deref()),
		"image" => resolve_image(node),
		"thumbnail" => resolve_thumbnail(node, qual.args.as_deref()),
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("unknown qualifier: {}", qual.name),
			span:    None,
		}),
	}
}

fn resolve_raw(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
	let (text, diag) = decode_text(content);
	let mut node = node.clone();
	node.content = Some(Content::Text { value: text });
	if let Some(d) = diag {
		node.diagnostics.push(d);
	}
	Ok(node)
}

fn resolve_bytes(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
	let mut node = node.clone();
	node.content = Some(Content::Bytes {
		artifact_uri: format!("artifact://{}", node.locator),
		size:         content.len() as u64,
	});
	Ok(node)
}

fn resolve_text(
	node: &NodeRef,
	content: &[u8],
	extractors: &[Arc<dyn FormatExtractor>],
) -> Result<NodeRef, Diagnostic> {
	let ext = std::path::Path::new(&node.locator)
		.extension()
		.and_then(|e| e.to_str())
		.unwrap_or("");

	for ex in extractors {
		if ex.extracts(ext) {
			let text = ex.extract(content, &crate::resolver::traits::CancellationToken::new())?;
			let mut node = node.clone();
			node.content =
				Some(Content::ExtractedText { source_kind: ext.to_string(), text, mime_type: None });
			return Ok(node);
		}
	}

	// Fallback to #raw behaviour.
	resolve_raw(node, content)
}

fn resolve_match(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
	let pattern = node
		.metadata
		.get("pattern")
		.and_then(|v| v.as_str())
		.unwrap_or("");
	if pattern.is_empty() {
		return Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "#match requires preceding TextMatch predicate".into(),
			span:    None,
		});
	}

	let re = regex::Regex::new(pattern).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("invalid regex: {e}"),
		span:    None,
	})?;

	let text = String::from_utf8_lossy(content);
	let m = re.find(&text).ok_or_else(|| Diagnostic {
		variant: DiagnosticVariant::NoMatches,
		message: "no regex match found for #match".into(),
		span:    None,
	})?;

	let mut node = node.clone();
	node.content = Some(Content::Text { value: m.as_str().to_string() });
	node.range = m.start()..m.end();
	Ok(node)
}

fn resolve_captures(node: &NodeRef, args: Option<&str>) -> Result<NodeRef, Diagnostic> {
	let idx: usize = args.and_then(|s| s.parse().ok()).unwrap_or(0);

	let captures = node
		.metadata
		.get("captures")
		.and_then(|v| v.as_array())
		.cloned()
		.unwrap_or_default();

	let value = captures
		.get(idx)
		.and_then(|v| v.as_str())
		.ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("capture index {idx} out of bounds"),
			span:    None,
		})?
		.to_string();

	let mut node = node.clone();
	node.content = Some(Content::Text { value });
	Ok(node)
}

fn resolve_lines(
	node: &NodeRef,
	content: &[u8],
	args: Option<&str>,
) -> Result<NodeRef, Diagnostic> {
	let (start, end) = parse_line_range(args)?;
	let step = Step {
		axis:       Some(Axis::Structural),
		head:       Head::NodeKind("line".to_string()),
		predicates: vec![Predicate::Range { start: Some(start), end: Some(end) }],
	};
	let lines = line_steps(content, &step);
	let text: String = lines
		.into_iter()
		.filter_map(|n| n.content)
		.filter_map(|c| match c {
			Content::Text { value } => Some(value),
			_ => None,
		})
		.collect();

	let mut node = node.clone();
	node.content = Some(Content::Text { value: text });
	Ok(node)
}

fn parse_line_range(args: Option<&str>) -> Result<(isize, isize), Diagnostic> {
	let s = args.unwrap_or("");
	if let Some((a, b)) = s.split_once("..") {
		let start = if a.is_empty() {
			1
		} else {
			a.parse::<isize>().map_err(|_| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("invalid line range start: {a}"),
				span:    None,
			})?
		};
		let end = if b.is_empty() {
			isize::MAX
		} else {
			b.parse::<isize>().map_err(|_| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("invalid line range end: {b}"),
				span:    None,
			})?
		};
		return Ok((start, end));
	}
	let n = s.parse::<isize>().map_err(|_| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("invalid line range: {s}"),
		span:    None,
	})?;
	Ok((n, n))
}

fn resolve_image(node: &NodeRef) -> Result<NodeRef, Diagnostic> {
	let path = std::path::Path::new(&node.locator);
	let bytes = std::fs::read(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("failed to read image file: {}", e),
		span:    None,
	})?;

	let mime = sniff_image_mime(&bytes);
	let (width, height) = if mime.starts_with("image/svg") {
		(Some(0), Some(0))
	} else {
		match image::image_dimensions(path) {
			Ok((w, h)) => (Some(w), Some(h)),
			Err(e) => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("IMAGE_DECODE_FAILED: {}", e),
					span:    None,
				});
			},
		}
	};

	const INLINE_THRESHOLD: usize = 512 * 1024;
	let image_bytes = if bytes.len() <= INLINE_THRESHOLD {
		Some(bytes)
	} else {
		None
	};

	let mut node = node.clone();
	node.content = Some(Content::Image {
		handle: format!("image://{}", node.locator),
		mime_type: mime.to_string(),
		width,
		height,
		bytes: image_bytes,
	});
	Ok(node)
}

fn resolve_thumbnail(node: &NodeRef, args: Option<&str>) -> Result<NodeRef, Diagnostic> {
	let size = args.and_then(|s| s.parse::<u32>().ok()).unwrap_or(256);
	let path = std::path::Path::new(&node.locator);
	let bytes = std::fs::read(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("failed to read image file: {}", e),
		span:    None,
	})?;

	let mime = sniff_image_mime(&bytes);
	if mime.starts_with("image/svg") {
		let mut node = node.clone();
		node.content = Some(Content::Image {
			handle:    format!("thumbnail://{}", node.locator),
			mime_type: mime.to_string(),
			width:     Some(0),
			height:    Some(0),
			bytes:     Some(bytes),
		});
		return Ok(node);
	}

	let dynamic = image::load_from_memory(&bytes).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("IMAGE_DECODE_FAILED: {}", e),
		span:    None,
	})?;

	let (orig_w, orig_h) = (dynamic.width(), dynamic.height());
	if orig_w <= size && orig_h <= size {
		let mut node = node.clone();
		node.content = Some(Content::Image {
			handle:    format!("thumbnail://{}", node.locator),
			mime_type: mime.to_string(),
			width:     Some(orig_w),
			height:    Some(orig_h),
			bytes:     Some(bytes),
		});
		return Ok(node);
	}

	let scale = (size as f32 / orig_w as f32).min(size as f32 / orig_h as f32);
	let target_w = (orig_w as f32 * scale).round() as u32;
	let target_h = (orig_h as f32 * scale).round() as u32;

	let resized = dynamic.resize(target_w, target_h, image::imageops::FilterType::Lanczos3);
	let mut buf = Vec::new();
	let mut cursor = std::io::Cursor::new(&mut buf);
	resized
		.write_to(&mut cursor, image::ImageFormat::Png)
		.map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("IMAGE_DECODE_FAILED: {}", e),
			span:    None,
		})?;

	let mut node = node.clone();
	node.content = Some(Content::Image {
		handle:    format!("thumbnail://{}", node.locator),
		mime_type: "image/png".to_string(),
		width:     Some(target_w),
		height:    Some(target_h),
		bytes:     Some(buf),
	});
	Ok(node)
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
	if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		return "image/png";
	}
	if bytes.starts_with(b"\xff\xd8\xff") {
		return "image/jpeg";
	}
	if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
		return "image/gif";
	}
	if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
		return "image/webp";
	}
	if bytes.starts_with(b"BM") {
		return "image/bmp";
	}
	if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
		return "image/tiff";
	}

	let trimmed = trim_ascii_whitespace(bytes);
	if trimmed.starts_with(b"<?xml") {
		if find_subsequence(trimmed, b"<svg").is_some() {
			return "image/svg+xml";
		}
	} else if trimmed.starts_with(b"<svg") {
		return "image/svg+xml";
	}

	"application/octet-stream"
}

fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
	let start = bytes
		.iter()
		.position(|&b| !b.is_ascii_whitespace())
		.unwrap_or(bytes.len());
	let end = bytes
		.iter()
		.rposition(|&b| !b.is_ascii_whitespace())
		.unwrap_or(0);
	if start > end {
		&[]
	} else {
		&bytes[start..=end]
	}
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

/// Decode bytes to text.  On invalid UTF-8 fall back to latin-1 lossy
/// and emit an `EncodingFallback` diagnostic.
fn decode_text(content: &[u8]) -> (String, Option<Diagnostic>) {
	match std::str::from_utf8(content) {
		Ok(s) => (s.to_string(), None),
		Err(_) => {
			let text: String = content.iter().map(|b| *b as char).collect();
			let diag = Diagnostic {
				variant: DiagnosticVariant::EncodingFallback,
				message: "file is not valid UTF-8; using latin-1 lossy fallback".into(),
				span:    None,
			};
			(text, Some(diag))
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn qualifier_raw_utf8() {
		let node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "raw".to_string(), args: None };
		let out = resolve_qualifier(&node, b"hello world", &qual, &[]).unwrap();
		assert_eq!(out.content, Some(Content::Text { value: "hello world".to_string() }));
	}

	#[test]
	fn qualifier_raw_latin1_fallback() {
		let node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "raw".to_string(), args: None };
		// 0xE9 is 'é' in latin-1 but invalid UTF-8
		let bytes = vec![0x68, 0xe9, 0x6c, 0x6c, 0x6f];
		let out = resolve_qualifier(&node, &bytes, &qual, &[]).unwrap();
		assert!(
			out.diagnostics
				.iter()
				.any(|d| matches!(d.variant, DiagnosticVariant::EncodingFallback))
		);
		assert_eq!(out.content, Some(Content::Text { value: "héllo".to_string() }));
	}

	#[test]
	fn qualifier_bytes() {
		let node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "bytes".to_string(), args: None };
		let out = resolve_qualifier(&node, b"data", &qual, &[]).unwrap();
		match out.content {
			Some(Content::Bytes { artifact_uri, size }) => {
				assert_eq!(size, 4);
				assert!(artifact_uri.contains("test.txt"));
			},
			other => panic!("expected Bytes, got {other:?}"),
		}
	}

	#[test]
	fn qualifier_lines_slice() {
		let node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "lines".to_string(), args: Some("2..3".to_string()) };
		let content = b"a\nb\nc\nd\n";
		let out = resolve_qualifier(&node, content, &qual, &[]).unwrap();
		assert_eq!(out.content, Some(Content::Text { value: "b\nc\n".to_string() }));
	}

	#[test]
	fn qualifier_image_populates_bytes_and_dimensions() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("img.png");
		// Minimal 1x1 PNG (base64-decoded TINY_PNG)
		let png_bytes = vec![
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
			0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
			0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x05, 0x02, 0x00, 0x5f, 0xc8, 0xf1, 0xd2, 0x00, 0x00,
			0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		];
		std::fs::write(&path, &png_bytes).unwrap();

		let node = NodeRef {
			locator:     path.to_str().unwrap().to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "image".to_string(), args: None };
		let out = resolve_qualifier(&node, b"", &qual, &[]).unwrap();
		match out.content {
			Some(Content::Image { mime_type, width, height, bytes, .. }) => {
				assert_eq!(mime_type, "image/png");
				assert_eq!(width, Some(1));
				assert_eq!(height, Some(1));
				assert!(bytes.is_some());
				assert_eq!(bytes.unwrap().len(), png_bytes.len());
			},
			other => panic!("expected Image, got {other:?}"),
		}
	}

	#[test]
	fn qualifier_image_large_file_omits_bytes() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("large.png");
		// Write a valid PNG header followed by padding to exceed 512 KiB
		let mut data = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		data.resize(600 * 1024, 0u8);
		std::fs::write(&path, &data).unwrap();

		let node = NodeRef {
			locator:     path.to_str().unwrap().to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "image".to_string(), args: None };
		// Corrupt/large file will fail image_dimensions -> returns diagnostic
		let out = resolve_qualifier(&node, b"", &qual, &[]);
		assert!(out.is_err());
	}

	#[test]
	fn qualifier_thumbnail_resizes() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("img.png");
		// Minimal 2x2 PNG
		let img = image::ImageBuffer::from_fn(2, 2, |x, y| image::Rgb([x as u8, y as u8, 0]));
		img.save(&path).unwrap();

		let node = NodeRef {
			locator:     path.to_str().unwrap().to_string(),
			range:       0..0,
			kind:        "§file".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		let qual = Qualifier { name: "thumbnail".to_string(), args: Some("1".to_string()) };
		let out = resolve_qualifier(&node, b"", &qual, &[]).unwrap();
		match out.content {
			Some(Content::Image { mime_type, width, height, bytes, .. }) => {
				assert_eq!(mime_type, "image/png");
				assert_eq!(width, Some(1));
				assert_eq!(height, Some(1));
				assert!(bytes.is_some());
			},
			other => panic!("expected Image, got {other:?}"),
		}
	}

	#[test]
	fn qualifier_captures() {
		let mut node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§line".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		node.metadata.insert(
			"captures".to_string(),
			serde_json::Value::Array(vec![
				serde_json::Value::String("first".to_string()),
				serde_json::Value::String("second".to_string()),
			]),
		);
		let qual = Qualifier { name: "captures".to_string(), args: Some("1".to_string()) };
		let out = resolve_qualifier(&node, b"", &qual, &[]).unwrap();
		assert_eq!(out.content, Some(Content::Text { value: "second".to_string() }));
	}

	#[test]
	fn qualifier_captures_out_of_bounds() {
		let mut node = NodeRef {
			locator:     "test.txt".to_string(),
			range:       0..0,
			kind:        "§line".to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		};
		node
			.metadata
			.insert("captures".to_string(), serde_json::Value::Array(vec![]));
		let qual = Qualifier { name: "captures".to_string(), args: Some("0".to_string()) };
		let res = resolve_qualifier(&node, b"", &qual, &[]);
		assert!(res.is_err());
	}
}
