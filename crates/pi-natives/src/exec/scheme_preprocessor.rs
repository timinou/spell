//! `SchemeWordPreprocessor` — bridges Spell's `SchemeRegistry` to brush's
//! `WordPreprocessor` hook so bash commands can use URI tokens natively.
//!
//! Replaces the TS-side `expandInternalUrls` regex pre-pass (which was
//! pre-tokenization, fragile to quoting). With this bridge, brush's own
//! lexer handles tokens, and URI substitution happens at the proper
//! word-expansion stage.
//!
//! PLAN-310 W5. Only fs-backed schemes (`capabilities.bash_expandable`)
//! participate; virtual schemes (mcp, canvas) defer to normal expansion
//! and produce an "unknown command" error at exec time.

use std::sync::Arc;

use brush_core::WordPreprocessor;
use pi_code_path::{
	resolver::traits::CancellationToken, scheme::SessionContext, scheme_dispatch::SchemeRegistry,
};

/// Word preprocessor that resolves `<scheme>://<body>` tokens to
/// shell-escaped filesystem paths via the kernel SchemeRegistry.
pub struct SchemeWordPreprocessor {
	registry: Arc<SchemeRegistry>,
	session:  Option<SessionContext>,
}

impl std::fmt::Debug for SchemeWordPreprocessor {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "SchemeWordPreprocessor(schemes={})", self.registry.known_schemes().len())
	}
}

impl SchemeWordPreprocessor {
	pub fn new(registry: Arc<SchemeRegistry>, session: Option<SessionContext>) -> Self {
		Self { registry, session }
	}
}

impl WordPreprocessor for SchemeWordPreprocessor {
	fn preprocess(&self, text: &str) -> Option<String> {
		let trimmed = text.trim();
		let (scheme, body) = trimmed.split_once("://")?;
		let profile = self.registry.lookup(scheme)?;
		if !profile.capabilities.bash_expandable {
			return None;
		}
		let uri =
			pi_code_path::ast::UriLocator { scheme: scheme.to_string(), path: body.to_string() };
		let cancel = CancellationToken::new();
		let resolved = self
			.registry
			.resolve(&uri, self.session.as_ref(), &cancel)
			.ok()?;
		let source_path = resolved.source_path.as_ref()?;
		Some(shell_escape(&source_path.to_string_lossy()))
	}
}

/// Single-quote shell escape: wraps in `'`, escapes inner `'` as `'\''`.
fn shell_escape(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 2);
	out.push('\'');
	for ch in s.chars() {
		if ch == '\'' {
			out.push_str("'\\''");
		} else {
			out.push(ch);
		}
	}
	out.push('\'');
	out
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;

	#[test]
	fn escape_no_quotes() {
		assert_eq!(shell_escape("/tmp/x.txt"), "'/tmp/x.txt'");
	}

	#[test]
	fn escape_inner_quote() {
		assert_eq!(shell_escape("/it's/path"), r"'/it'\''s/path'");
	}

	#[test]
	fn preprocess_defers_for_non_uri() {
		let reg = Arc::new(SchemeRegistry::new());
		let pre = SchemeWordPreprocessor::new(reg, None);
		assert_eq!(pre.preprocess("plain-text"), None);
		assert_eq!(pre.preprocess("/abs/path"), None);
	}

	#[test]
	fn preprocess_defers_for_unknown_scheme() {
		let reg = Arc::new(SchemeRegistry::new());
		let pre = SchemeWordPreprocessor::new(reg, None);
		assert_eq!(pre.preprocess("nope://body"), None);
	}

	#[test]
	fn preprocess_skips_when_not_bash_expandable() {
		use pi_code_path::{
			CacheStrategy, ContentLoader, PathLayout, RootTemplate, SchemeCapabilities, SchemeProfile,
		};
		let mut reg = SchemeRegistry::new();
		// virtual scheme — bash_expandable: false
		reg.register_dynamic_profile(SchemeProfile {
			scheme:       "virtual-svc",
			root:         RootTemplate::Virtual,
			layout:       PathLayout::Direct,
			loader:       ContentLoader::Static { table: &phf::phf_map! { "x" => "data" } },
			capabilities: SchemeCapabilities {
				fs_backed: false,
				bash_expandable: false,
				cache: CacheStrategy::None,
				..Default::default()
			},
		})
		.unwrap();
		let pre = SchemeWordPreprocessor::new(Arc::new(reg), None);
		assert_eq!(pre.preprocess("virtual-svc://x"), None);
	}

	#[test]
	fn preprocess_returns_escaped_path_for_fs_scheme() {
		use pi_code_path::{
			CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
			SchemeProfile,
		};
		// Build a tiny fixture: profile that always points at a fixed file
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("hello.txt");
		std::fs::write(&target, "hi\n").unwrap();
		let mut reg = SchemeRegistry::new();
		reg.register_dynamic_profile(SchemeProfile {
			scheme:       "tfile",
			root:         RootTemplate::AbsoluteRoot { path: dir.path().to_path_buf() },
			layout:       PathLayout::Direct,
			loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
			capabilities: SchemeCapabilities {
				fs_backed: true,
				bash_expandable: true,
				cache: CacheStrategy::None,
				..Default::default()
			},
		})
		.unwrap();
		let pre = SchemeWordPreprocessor::new(Arc::new(reg), None);
		let out = pre.preprocess("tfile://hello.txt").expect("resolved");
		// Single-quoted path
		assert!(out.starts_with('\''));
		assert!(out.ends_with('\''));
		assert!(out.contains("hello.txt"));
		let _ = PathBuf::from(out.trim_matches('\''));
	}
}
