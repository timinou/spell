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
			content:      Content::Text {
				value: format!("{} (for body={body})", self.response),
			},
			mime:         None,
			notes:        vec![],
			source_mtime: None,
		})
	}
}

fn build_dynamic_profile(name: &'static str, response: &str) -> SchemeProfile {
	SchemeProfile {
		scheme:       name,
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
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("skill", "evil"))
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
	let mut reg = SchemeRegistry::from_static(
		[pi_natives::code_path::uri::skill::build as _],
		None,
	);
	// Attempt to override skill via dynamic should reject (reserved).
	let err = reg
		.register_dynamic_profile(build_dynamic_profile("skill", "x"))
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
	assert!(names.contains(&"skill".to_string()));
	assert!(names.contains(&"custom-svc".to_string()));
}
