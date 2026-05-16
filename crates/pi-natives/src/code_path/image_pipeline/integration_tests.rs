use std::path::PathBuf;

use image::{ImageBuffer, Rgb};
use pi_code_path::{
	ast::Qualifier,
	dialects::text::qualifiers::resolve_qualifier,
	types::{Content, NodeRef},
};
use tempfile::TempDir;

use crate::code_path::marshal::nodes_to_dtos;

fn make_node(locator: impl Into<String>) -> NodeRef {
	NodeRef {
		locator:     locator.into(),
		range:       0..0,
		kind:        "§file".to_string(),
		content:     None,
		metadata:    Default::default(),
		diagnostics: vec![],
	}
}

fn temp_png(w: u32, h: u32, dir: &TempDir, name: &str) -> PathBuf {
	let path = dir.path().join(name);
	let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
		ImageBuffer::from_fn(w, h, |x, y| Rgb([x as u8, y as u8, (x ^ y) as u8]));
	img.save(&path).unwrap();
	path
}

#[test]
fn small_png_image_returns_content_dto_with_data() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_png(32, 32, &dir, "small.png");
	let node = make_node(path.to_str().unwrap());
	let qual = Qualifier { name: "image".to_string(), args: None };
	let resolved = resolve_qualifier(&node, b"", &qual, &[]).unwrap();

	// Verify kernel side
	match &resolved.content {
		Some(Content::Image { mime_type, width, height, bytes, .. }) => {
			assert_eq!(mime_type, "image/png");
			assert_eq!(*width, Some(32));
			assert_eq!(*height, Some(32));
			assert!(bytes.is_some());
		},
		other => panic!("expected Image, got {other:?}"),
	}

	let dtos = nodes_to_dtos(vec![resolved], 512 * 1024);
	let dto = dtos[0].content.as_ref().unwrap();
	assert_eq!(dto.kind, "image");
	assert_eq!(dto.mime_type, Some("image/png".to_string()));
	assert_eq!(dto.width, Some(32));
	assert_eq!(dto.height, Some(32));
	assert!(dto.value.is_some());
	assert!(dto.artifact_uri.is_none());
}

#[test]
fn large_png_image_returns_content_dto_with_handle() {
	// When bytes exceed the kernel-side load threshold, the kernel emits
	// `Content::Image { bytes: None, handle, ... }`. The marshal layer must
	// surface that handle on the dto (NOT as artifact_uri, which would be
	// interpreted by the JS layer as base64 image data and produce a 400 from
	// Anthropic — see BUG-377).
	let dir = tempfile::tempdir().unwrap();
	let path = temp_png(2048, 2048, &dir, "large.png");
	let metadata = std::fs::metadata(&path).unwrap();
	assert!(
		metadata.len() > 512 * 1024,
		"synthesised PNG should exceed 512 KiB, got {} bytes",
		metadata.len()
	);

	let node = make_node(path.to_str().unwrap());
	let qual = Qualifier { name: "image".to_string(), args: None };
	let resolved = resolve_qualifier(&node, b"", &qual, &[]).unwrap();

	// Kernel side: bytes omitted for large files
	match &resolved.content {
		Some(Content::Image { mime_type, width, height, bytes, .. }) => {
			assert_eq!(mime_type, "image/png");
			assert!(width.is_some());
			assert!(height.is_some());
			assert!(bytes.is_none());
		},
		other => panic!("expected Image, got {other:?}"),
	}

	let dtos = nodes_to_dtos(vec![resolved], 512 * 1024);
	let dto = dtos[0].content.as_ref().unwrap();
	assert_eq!(dto.kind, "image");
	assert_eq!(dto.mime_type, Some("image/png".to_string()));
	assert!(dto.width.is_some());
	assert!(dto.height.is_some());
	// Crucial invariant for BUG-377: never leak a URI into a field the JS
	// consumer will treat as base64 data. Use the dedicated `handle` field.
	assert!(dto.handle.is_some(), "large image without bytes must surface its handle");
	assert!(dto.artifact_uri.is_none(), "artifact_uri must not be set for image content (BUG-377)");
	assert!(dto.value.is_none(), "value must not be set when bytes are absent");
}

#[test]
fn thumbnail_resizes_to_max_edge() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_png(512, 256, &dir, "small.png");
	let node = make_node(path.to_str().unwrap());
	let qual = Qualifier { name: "thumbnail".to_string(), args: Some("256".to_string()) };
	let resolved = resolve_qualifier(&node, b"", &qual, &[]).unwrap();

	let dtos = nodes_to_dtos(vec![resolved], 512 * 1024);
	let dto = dtos[0].content.as_ref().unwrap();
	assert_eq!(dto.kind, "image");
	assert_eq!(dto.mime_type, Some("image/png".to_string()));
	assert_eq!(dto.width, Some(256));
	assert_eq!(dto.height, Some(128));
	assert!(dto.value.is_some());
	assert!(dto.artifact_uri.is_none());
}

#[test]
fn svg_image_returns_inline_text_content() {
	// SVG is XML text, not a raster image format. Anthropic and OpenAI vision
	// APIs only accept PNG/JPEG/GIF/WebP, so emitting an `image` block for SVG
	// guarantees a 400 (see BUG-378 hardening). Marshal downgrades SVG to
	// `extracted_text` with the SVG source preserved as `value`, which the
	// model can still reason about — strictly better than dropping or 400.
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("small.svg");
	let svg_source = r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>
"#;
	std::fs::write(&path, svg_source).unwrap();

	let node = make_node(path.to_str().unwrap());
	let qual = Qualifier { name: "image".to_string(), args: None };
	let resolved = resolve_qualifier(&node, b"", &qual, &[]).unwrap();

	let dtos = nodes_to_dtos(vec![resolved], 512 * 1024);
	let dto = dtos[0].content.as_ref().unwrap();
	assert_eq!(dto.kind, "extracted_text", "SVG must not surface as image (BUG-378)");
	assert_eq!(dto.mime_type, Some("image/svg+xml".to_string()));
	assert_eq!(dto.source_kind, Some("image".to_string()));
	let value = dto.value.as_ref().expect("SVG source preserved as text");
	assert!(value.contains("<svg"), "SVG markup preserved verbatim, got: {value}");
	assert!(dto.artifact_uri.is_none());
}

#[test]
fn unsupported_tiff_returns_image_decode_failed() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("unsupported.tiff");
	// Write a minimal TIFF header so mime sniff recognises it, but not enough data
	// for decoding
	std::fs::write(&path, b"II*\x00").unwrap();

	let node = make_node(path.to_str().unwrap());
	let qual = Qualifier { name: "image".to_string(), args: None };
	let res = resolve_qualifier(&node, b"", &qual, &[]);
	assert!(res.is_err(), "expected IMAGE_DECODE_FAILED diagnostic");
	let err = res.unwrap_err();
	assert!(err.message.contains("IMAGE_DECODE_FAILED"));
}
