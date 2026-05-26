//! Diagnostics surface.
//!
//! `publishDiagnostics` push notifications are cached inside
//! [`super::client::LspClient`] (see `convert_lsp_diagnostics`). This
//! module exposes the read side as a free function so callers don't
//! need to know the cache lives on the client.
//!
//! For LSP 3.17+ servers that support pull-based diagnostics
//! (`textDocument/diagnostic`), a future iteration can fall back to a
//! synchronous pull when the push cache is empty for a given file.
//! That's not wired yet — push is the dominant path for the four
//! servers PLAN-319/320 target (Expert, vtsls, rust-analyzer, pyrefly).

use std::path::Path;

use lsp_types::Url;

use super::client::LspClient;
use crate::semantic::Diagnostic;

pub fn diagnostics_for_path(client: &LspClient, path: &Path) -> Vec<Diagnostic> {
	let Some(uri) = path_to_uri(path) else {
		return Vec::new();
	};
	client.diagnostics_for(&uri)
}

fn path_to_uri(path: &Path) -> Option<Url> {
	Url::from_file_path(path).ok()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn path_to_uri_round_trip_for_absolute() {
		let p = Path::new("/tmp/foo.rs");
		let uri = path_to_uri(p).expect("absolute path uri");
		assert_eq!(uri.scheme(), "file");
	}
}
