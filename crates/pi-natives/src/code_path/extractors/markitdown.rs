use std::{
	io::{Read, Write},
	path::PathBuf,
	process::{Command, Stdio},
	time::Duration,
};

use pi_code_path::{
	resolver::{CancellationToken, FormatExtractor},
	types::{Diagnostic, DiagnosticVariant},
};

// TODO: tempfile is only in [dev-dependencies]; once moved to [dependencies],
// replace this helper with tempfile::NamedTempFile.
struct TempFile {
	path: PathBuf,
}

impl TempFile {
	fn new() -> std::io::Result<Self> {
		let name = format!("pi_natives_markitdown_{}.tmp", std::process::id());
		let path = std::env::temp_dir().join(name);
		std::fs::File::create(&path)?;
		Ok(TempFile { path })
	}

	fn path(&self) -> &std::path::Path {
		&self.path
	}
}

impl Drop for TempFile {
	fn drop(&mut self) {
		let _ = std::fs::remove_file(&self.path);
	}
}

const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
const TRUNCATION_NOTICE: &str = "\n[truncated by extractor]\n";

pub struct MarkitdownExtractor {
	pub timeout_secs: u64,
}

impl MarkitdownExtractor {
	pub fn new() -> Self {
		MarkitdownExtractor { timeout_secs: 30 }
	}
}

impl Default for MarkitdownExtractor {
	fn default() -> Self {
		Self::new()
	}
}

impl FormatExtractor for MarkitdownExtractor {
	fn extracts(&self, ext: &str) -> bool {
		matches!(
			ext.to_ascii_lowercase().as_str(),
			"pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "rtf" | "epub"
		)
	}

	fn extract(&self, bytes: &[u8], cancel: &CancellationToken) -> Result<String, Diagnostic> {
		if cancel.is_cancelled() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::Cancelled,
				message: "extraction cancelled".to_string(),
				span:    None,
			});
		}

		let temp = TempFile::new().map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("failed to create temp file: {e}"),
			span:    None,
		})?;
		{
			let mut file = std::fs::OpenOptions::new()
				.write(true)
				.open(temp.path())
				.map_err(|e| Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("failed to open temp file: {e}"),
					span:    None,
				})?;
			file.write_all(bytes).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("failed to write temp file: {e}"),
				span:    None,
			})?;
		}

		let mut child = Command::new("markitdown")
			.arg(temp.path())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.map_err(|e| {
				if e.kind() == std::io::ErrorKind::NotFound {
					Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: "markitdown not found; install via `uv tool install markitdown` or \
						          `pip install markitdown`"
							.to_string(),
						span:    None,
					}
				} else {
					Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: format!("failed to spawn markitdown: {e}"),
						span:    None,
					}
				}
			})?;

		let timeout = Duration::from_secs(self.timeout_secs);
		let status =
			wait_timeout::ChildExt::wait_timeout(&mut child, timeout).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("error waiting for markitdown: {e}"),
				span:    None,
			})?;

		match status {
			Some(code) if code.success() => {
				let mut stdout = child.stdout.take().expect("stdout piped");
				let mut buf = Vec::new();
				stdout.read_to_end(&mut buf).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("failed to read markitdown stdout: {e}"),
					span:    None,
				})?;

				let mut text = String::from_utf8_lossy(&buf).into_owned();
				if text.len() > MAX_OUTPUT_BYTES {
					let mut truncated = text;
					truncated.truncate(MAX_OUTPUT_BYTES);
					truncated.push_str(TRUNCATION_NOTICE);
					text = truncated;
				}
				Ok(text)
			},
			Some(code) => Err(Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("markitdown exited with status {code}"),
				span:    None,
			}),
			None => {
				let _ = child.kill();
				Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("markitdown extraction timed out after {}s", self.timeout_secs),
					span:    None,
				})
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extracts_pdf() {
		let e = MarkitdownExtractor::new();
		assert!(e.extracts("pdf"));
		assert!(e.extracts("PDF"));
	}

	#[test]
	fn extracts_docx() {
		let e = MarkitdownExtractor::new();
		assert!(e.extracts("docx"));
	}

	#[test]
	fn does_not_extract_txt() {
		let e = MarkitdownExtractor::new();
		assert!(!e.extracts("txt"));
	}

	#[test]
	fn binary_missing_diagnostic() {
		let e = MarkitdownExtractor { timeout_secs: 5 };
		// Temporarily override PATH to a non-existent directory so markitdown
		// cannot be found, triggering the NotFound branch.
		let result = std::env::var_os("PATH").and_then(|original_path| {
			unsafe {
				std::env::set_var("PATH", "/nonexistent/bin");
			}
			let res = e.extract(b"fake pdf bytes", &CancellationToken::new());
			unsafe {
				std::env::set_var("PATH", original_path);
			}
			Some(res)
		});

		let err = result.expect("PATH env var should exist").unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::ParseError));
		assert!(err.message.contains("markitdown not found"));
		assert!(err.message.contains("uv tool install markitdown"));
	}

	#[test]
	#[ignore = "requires markitdown binary installed"]
	fn real_pdf_extraction() {
		let e = MarkitdownExtractor::new();
		// Placeholder: supply real PDF bytes if available.
		let _ = e.extract(b"%PDF-1.4", &CancellationToken::new());
	}
}
