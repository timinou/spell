use std::{io::Cursor, path::Path};

use pi_code_path::types::{Diagnostic, DiagnosticVariant};

pub const DEFAULT_INLINE_THRESHOLD_BYTES: u64 = 524_288; // 512 KiB
pub const DEFAULT_MAX_BYTES: u64 = 20_971_520; // 20 * 1024 * 1024

#[derive(Debug, Clone)]
pub struct ImageLoader {
	pub inline_threshold_bytes: u64,
	pub max_bytes:              u64,
}

impl Default for ImageLoader {
	fn default() -> Self {
		Self {
			inline_threshold_bytes: DEFAULT_INLINE_THRESHOLD_BYTES,
			max_bytes:              DEFAULT_MAX_BYTES,
		}
	}
}

#[derive(Debug, Clone)]
pub struct LoadedImage {
	pub bytes:        Vec<u8>,
	pub mime:         String,
	pub width:        u32,
	pub height:       u32,
	pub needs_resize: bool,
}

pub fn load(path: &Path, opts: &ImageLoader) -> Result<LoadedImage, Diagnostic> {
	let bytes = std::fs::read(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("failed to read image file: {}", e),
		span:    None,
	})?;

	let len = bytes.len() as u64;
	if len > opts.max_bytes {
		return Err(Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("image too large: {} bytes > max {}", len, opts.max_bytes),
			span:    None,
		});
	}

	let mime = sniff_mime(&bytes);

	if mime.starts_with("image/svg") {
		return Ok(LoadedImage {
			bytes,
			mime: mime.to_string(),
			width: 0,
			height: 0,
			needs_resize: false,
		});
	}

	let reader = image::ImageReader::new(Cursor::new(&bytes))
		.with_guessed_format()
		.map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("unrecognized image format: {}", e),
			span:    None,
		})?;

	let (width, height) = reader.into_dimensions().map_err(|e| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("failed to read image dimensions: {}", e),
		span:    None,
	})?;

	let needs_resize = len > opts.inline_threshold_bytes;

	Ok(LoadedImage { bytes, mime: mime.to_string(), width, height, needs_resize })
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
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
