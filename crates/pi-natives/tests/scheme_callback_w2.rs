//! W2 integration: dynamic SchemeProfile registration + dispatch.
//!
//! Tests use a Rust-side `SchemeCallback` impl rather than a real JS TSFn,
//! since napi context is unavailable in cargo tests. The TSFn path is
//! exercised end-to-end in `bun test` once W6 wires MCP advertisement.

use std::{sync::Arc, time::Duration};

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ResolvedContent, RootTemplate, SchemeCallback,
	SchemeCapabilities, SchemeProfile, SessionContext, UriLocator,
	resolver::traits::CancellationToken,
	scheme_dispatch::SchemeRegistry,
	types::{Content, Diagnostic, DiagnosticVariant},
};

struct FakeCallback {
	response: String,
}

impl SchemeCallback for FakeCallback {
	fn resolve(
		&self,
		body: &str,
		_ctx: Option<&SessionContext>,
		_cancel: &CancellationToken,
	) -> Result<ResolvedContent, Diagnostic> {
		Ok(ResolvedContent {
			url:          format!("test://{body}"),
			source_path:  None,
			content:      Content::Text { value: format!("{} (for body={body})", self.response) },
			mime:         None,
			notes:        vec![],
			source_mtime: None,
		})
	}
}

fn build_dynamic_profile(name: &'static str, response: &str) -> SchemeProfile {
	SchemeProfile {
		scheme:       name,
		usage:        "<test>://<body>",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Callback(Arc::new(FakeCallback {
			response: response.to_string(),
		})),
		capabilities: SchemeCapabilities {
			fs_backed:           false,
			codepath_compatible: false,
			mime_hint:           None,
			cache:               CacheStrategy::None,
			bash_expandable:     false,
			callback_budget:     Some(Duration::from_secs(5)),
			static_notes:        &[],
		},
	}
}

#[test]
fn dynamic_profile_dispatches_to_callback() {
	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(build_dynamic_profile("figma", "FIGMA-RESPONSE"))
		.unwrap();
	let uri = UriLocator { scheme: "figma".into(), path: "file/abc".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, None, &cancel).unwrap();
	match &r.content {
		Content::Text { value } => {
			assert!(value.contains("FIGMA-RESPONSE"));
			assert!(value.contains("file/abc"));
		},
		_ => panic!("expected Text"),
	}
}

#[test]
fn dynamic_profile_collision_with_reserved_rejected() {
	let mut reg = SchemeRegistry::new();
	// 'memory' is reserved (declarative profile under uri/memory.rs);
	// 'skill', 'rule', 'jobs' are no longer reserved post-PLAN-310 cutover.
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("memory", "evil"))
		.unwrap_err();
	assert!(err.message.contains("reserved"));
}

#[test]
fn dynamic_profile_collision_with_existing_rejected() {
	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(build_dynamic_profile("figma", "v1"))
		.unwrap();
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("figma", "v2"))
		.unwrap_err();
	assert!(err.message.contains("already registered"));
}

#[test]
fn dynamic_profile_invalid_name_rejected() {
	let mut reg = SchemeRegistry::new();
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("Bad-Name", "x"))
		.unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::ParseError));
}

#[test]
fn static_profile_takes_precedence_over_dynamic() {
	// scheme_dispatch::SchemeRegistry::lookup checks static map first.
	let mut reg =
		SchemeRegistry::from_static([pi_natives::code_path::uri::memory::build as _], None);
	// Attempt to override memory via dynamic should reject (reserved).
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("memory", "x"))
		.unwrap_err();
	assert!(err.message.contains("reserved"));
}

#[test]
fn registry_for_session_merges_static_and_dynamic() {
	// Reset runtime registry state.
	pi_natives::code_path::runtime_schemes::clear_runtime_schemes();

	// No JS callback available in test; use the dynamic-profile path directly.
	let mut snapshot_reg = pi_code_path::scheme_dispatch::SchemeRegistry::from_static(
		pi_natives::code_path::uri::SCHEME_FACTORIES.iter().copied(),
		None,
	);
	snapshot_reg
		.register_dynamic_profile(build_dynamic_profile("custom-svc", "ok"))
		.unwrap();
	let names = snapshot_reg.known_schemes();
	assert!(names.contains(&"memory".to_string()), "got: {names:?}");
	assert!(names.contains(&"custom-svc".to_string()));
}

// ── Wave 1: callback source_path passthrough ─────────────────────

struct FsBackedCallback {
	source_path: std::path::PathBuf,
	content:     String,
}

impl SchemeCallback for FsBackedCallback {
	fn resolve(
		&self,
		body: &str,
		_ctx: Option<&SessionContext>,
		_cancel: &CancellationToken,
	) -> Result<ResolvedContent, Diagnostic> {
		Ok(ResolvedContent {
			url:          format!("fsback://{body}"),
			source_path:  Some(self.source_path.clone()),
			content:      Content::Text { value: self.content.clone() },
			mime:         Some("text/plain".into()),
			notes:        vec![],
			source_mtime: None,
		})
	}
}

#[test]
fn callback_can_emit_source_path() {
	// When a callback profile returns source_path, the kernel surfaces it on
	// the ResolvedContent so downstream consumers (codepath suffix forwarding,
	// brush expansion) can use it.
	let dir = tempfile::TempDir::new().unwrap();
	let file = dir.path().join("x.txt");
	std::fs::write(&file, "on-disk content").unwrap();

	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(SchemeProfile {
		scheme:       "fsback",
		usage:        "fsback://<id>",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Callback(Arc::new(FsBackedCallback {
			source_path: file.clone(),
			content:     "on-disk content".into(),
		})),
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/plain"),
			cache:               CacheStrategy::None,
			bash_expandable:     true,
			callback_budget:     Some(Duration::from_secs(5)),
			static_notes:        &[],
		},
	})
	.unwrap();

	let uri = UriLocator { scheme: "fsback".into(), path: "my-item".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, None, &cancel).unwrap();
	assert_eq!(r.source_path, Some(file));
	assert_eq!(r.mime, Some("text/plain".into()));
}

// ── Wave 2 BUG-393: rule:// becomes callback-only ───────────────

#[test]
fn rule_scheme_no_longer_reserved() {
	// After Wave 2 cutover, 'rule' is removed from kernel reserved schemes.
	// Dynamic registration must succeed.
	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(build_dynamic_profile("rule", "DYN-RULE-RESPONSE"))
		.expect("dynamic 'rule' must register after Wave 2 cutover");
}

#[test]
fn rule_callback_resolves_with_source_path() {
	// Real-shape test for the rule:// callback: discovery is in-memory but
	// content lives on disk. Callback returns source_path so codepath
	// suffixes work end-to-end.
	let dir = tempfile::TempDir::new().unwrap();
	let rule_file = dir.path().join("no-unwrap.md");
	std::fs::write(&rule_file, "# No unwrap\n\nForbid `.unwrap()` in src/.\n").unwrap();

	struct RuleCallback {
		path:    std::path::PathBuf,
		content: String,
	}
	impl SchemeCallback for RuleCallback {
		fn resolve(
			&self,
			body: &str,
			_ctx: Option<&SessionContext>,
			_cancel: &CancellationToken,
		) -> Result<ResolvedContent, Diagnostic> {
			if body != "no-unwrap" {
				return Err(Diagnostic {
					variant: DiagnosticVariant::FileNotFound,
					message: format!("rule '{body}' not found"),
					span:    None,
				});
			}
			Ok(ResolvedContent {
				url:          format!("rule://{body}"),
				source_path:  Some(self.path.clone()),
				content:      Content::Text { value: self.content.clone() },
				mime:         Some("text/markdown".into()),
				notes:        vec![],
				source_mtime: None,
			})
		}
	}

	let content = std::fs::read_to_string(&rule_file).unwrap();
	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(SchemeProfile {
		scheme:       "rule",
		usage:        "rule://<name>",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Callback(Arc::new(RuleCallback {
			path:    rule_file.clone(),
			content: content.clone(),
		})),
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::None,
			bash_expandable:     false,
			callback_budget:     Some(Duration::from_secs(1)),
			static_notes:        &[],
		},
	})
	.unwrap();

	let uri = UriLocator { scheme: "rule".into(), path: "no-unwrap".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, None, &cancel).unwrap();
	assert_eq!(r.source_path, Some(rule_file));
	match &r.content {
		Content::Text { value } => assert!(value.contains("No unwrap")),
		_ => panic!("expected text"),
	}

	// Missing rule → FileNotFound diagnostic.
	let missing = UriLocator { scheme: "rule".into(), path: "does-not-exist".into() };
	let err = reg.resolve(&missing, None, &cancel).unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
}
