//! PLAN-310 hint quality: diagnostics produced by `SchemeProfile` dispatch
//! must surface the scheme name + canonical usage form, not leak internal
//! `PathLayout` enum variant names (e.g. "NamedFile expects a bare name").

use pi_code_path::{
	UriLocator, resolver::traits::CancellationToken, scheme::SessionContext,
	scheme_dispatch::SchemeRegistry,
};
use pi_natives::code_path::uri::SCHEME_FACTORIES;
use tempfile::TempDir;

fn registry(ctx: Option<&SessionContext>) -> SchemeRegistry {
	SchemeRegistry::from_static(SCHEME_FACTORIES.iter().copied(), ctx)
}

fn ctx_with_session(dir: &std::path::Path) -> SessionContext {
	SessionContext::new(dir, "/home/u").with_session_dir(dir)
}

/// Error messages must never expose `PathLayout` enum variant names.
/// These would leak the impl detail and confuse users:
///   - "NamedFile"
///   - "NamedDir"
///   - "Namespaced"
///   - "IdFragment"
///   - "Indexed layout"
fn assert_no_enum_leaks(msg: &str) {
	for forbidden in ["NamedFile", "NamedDir", "Namespaced", "IdFragment"] {
		assert!(
			!msg.contains(forbidden),
			"diagnostic leaks PathLayout enum '{forbidden}': {msg}"
		);
	}
}

// ── agent:// (NamedFile) ────────────────────────────────────────

#[test]
fn agent_bare_uri_has_friendly_hint() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "agent".into(), path: "".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("agent://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
	assert!(err.message.contains("agent://<id>"), "diag: {}", err.message);
}

#[test]
fn agent_subpath_rejected_with_hint() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "agent".into(), path: "foo/bar".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("agent://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
}

// ── memory:// (Namespaced) ──────────────────────────────────────

#[test]
fn memory_bare_uri_has_friendly_hint() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "memory".into(), path: "".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("memory://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
	assert!(err.message.contains("memory://root"), "diag: {}", err.message);
}

#[test]
fn memory_unknown_namespace_includes_expected() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "memory".into(), path: "notroot".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(
		err.message.contains("'notroot'") && err.message.contains("'root'"),
		"should explain both given and expected namespaces: {}",
		err.message
	);
}

// ── pi:// (Static) ──────────────────────────────────────────────

#[test]
fn pi_unknown_doc_includes_usage_hint() {
	let reg = registry(None);
	let uri = UriLocator { scheme: "pi".into(), path: "nonexistent.md".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, None, &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("pi://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
	assert!(
		err.message.contains("pi://<filename>.md"),
		"diag: {}",
		err.message
	);
}

// ── org:// (Indexed) ────────────────────────────────────────────

#[test]
fn org_bare_uri_has_friendly_hint() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "org".into(), path: "".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("org://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
	assert!(
		err.message.contains("org://<CUSTOM_ID>"),
		"diag: {}",
		err.message
	);
}

// ── artifact:// (Indexed) ───────────────────────────────────────

#[test]
fn artifact_bare_uri_has_friendly_hint() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "artifact".into(), path: "".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("artifact://"), "diag: {}", err.message);
	assert!(err.message.contains("usage:"), "diag: {}", err.message);
}

// ── local:// (Direct + traversal defense) ───────────────────────

#[test]
fn local_traversal_message_no_enum_leak() {
	let dir = TempDir::new().unwrap();
	let ctx = ctx_with_session(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "local".into(), path: "../etc/passwd".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert_no_enum_leaks(&err.message);
	assert!(err.message.contains("escapes scheme root"), "diag: {}", err.message);
}
