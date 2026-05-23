//! W1 integration: auto-registry populated from
//! `crates/pi-natives/src/code_path/uri/` resolves each declarative profile
//! against fixture filesystems.

use pi_code_path::{
	UriLocator, resolver::traits::CancellationToken, scheme::SessionContext,
	scheme_dispatch::SchemeRegistry, types::Content,
};
use pi_natives::code_path::uri::SCHEME_FACTORIES;
use tempfile::TempDir;

fn registry(ctx: Option<&SessionContext>) -> SchemeRegistry {
	SchemeRegistry::from_static(SCHEME_FACTORIES.iter().copied(), ctx)
}

#[test]
fn auto_registry_contains_w1_profiles() {
	let reg = registry(None);
	let names = reg.known_schemes();
	// PLAN-310 BUG-393/394/395: skill, rule, jobs removed from declarative
	// registry; now wired dynamically via registerScheme at session start.
	for expected in ["memory", "local", "pi"] {
		assert!(names.contains(&expected.to_string()), "missing {expected}");
	}
	for unexpected in ["skill", "rule", "jobs"] {
		assert!(
			!names.contains(&unexpected.to_string()),
			"{unexpected} should no longer be a static profile"
		);
	}
}

// PLAN-310 BUG-393/394: skill:// and rule:// moved to dynamic callback
// registration. See scheme_callback_w2.rs::rule_callback_resolves_with_source_path
// for the equivalent test against the callback profile shape.

#[test]
fn memory_resolves_root() {
	let dir = TempDir::new().unwrap();
	let mem_file = dir.path().join(".spell/memory/memory_summary.md");
	std::fs::create_dir_all(mem_file.parent().unwrap()).unwrap();
	std::fs::write(&mem_file, "# memory\n").unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	// `memory://root` → default file `memory_summary.md` (Namespaced layout).
	let uri = UriLocator { scheme: "memory".into(), path: "root".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert!(r.source_path.is_some());
	assert_eq!(r.source_path.as_ref().unwrap(), &mem_file);
}

#[test]
fn memory_resolves_subpath() {
	let dir = TempDir::new().unwrap();
	let sub = dir.path().join(".spell/memory/sub/note.md");
	std::fs::create_dir_all(sub.parent().unwrap()).unwrap();
	std::fs::write(&sub, "# sub\n").unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "memory".into(), path: "root/sub/note.md".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path.as_ref().unwrap(), &sub);
}

#[test]
fn memory_unknown_namespace_rejected() {
	let dir = TempDir::new().unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "memory".into(), path: "other".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(err.message.contains("namespace"), "diag: {}", err.message);
}

#[test]
fn local_requires_session_dir() {
	let dir = TempDir::new().unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "local".into(), path: "x.txt".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(err.message.contains("SessionRoot"));
}

#[test]
fn local_resolves_with_session_dir() {
	let dir = TempDir::new().unwrap();
	let sess = dir.path().join("session-abc");
	std::fs::create_dir_all(sess.join("local")).unwrap();
	std::fs::write(sess.join("local/notes.md"), "session notes\n").unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u").with_session_dir(&sess);
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "local".into(), path: "notes.md".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(sess.join("local/notes.md")));
}

#[test]
fn unknown_scheme_returns_diagnostic() {
	let reg = registry(None);
	let uri = UriLocator { scheme: "nope".into(), path: "x".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, None, &cancel).unwrap_err();
	assert!(err.message.contains("unknown URI scheme"));
}

#[test]
fn missing_file_returns_filenotfound() {
	let dir = TempDir::new().unwrap();
	std::fs::create_dir_all(dir.path().join(".spell/memory")).unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	// PLAN-310: use memory:// (kernel-owned) instead of skill:// (now dynamic).
	let uri = UriLocator { scheme: "memory".into(), path: "root/nonexistent.md".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(matches!(err.variant, pi_code_path::types::DiagnosticVariant::FileNotFound));
}

#[test]
fn pi_lists_embedded_docs() {
	let reg = registry(None);
	assert!(reg.has_scheme("pi"));
}

#[test]
fn pi_resolves_known_doc() {
	let reg = registry(None);
	let uri = UriLocator { scheme: "pi".into(), path: "memory.md".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, None, &cancel).unwrap();
	assert!(r.source_path.is_none());
	match &r.content {
		Content::Text { value } => assert!(!value.is_empty()),
		_ => panic!("expected Text"),
	}
}

#[test]
fn pi_unknown_doc_returns_not_found() {
	let reg = registry(None);
	let uri = UriLocator { scheme: "pi".into(), path: "definitely-not-a-real-doc-name.md".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, None, &cancel).unwrap_err();
	assert!(matches!(err.variant, pi_code_path::types::DiagnosticVariant::FileNotFound));
}

#[test]
fn session_context_built_from_task_options() {
	let opts = pi_natives::code_path::napi::CodePathTaskOptions {
		root: Some("/proj".into()),
		home: Some("/home/u".into()),
		session_dir: Some("/sess".into()),
		..Default::default()
	};
	let ctx = opts.session_context().expect("ctx");
	assert_eq!(ctx.project_root, std::path::PathBuf::from("/proj"));
	assert_eq!(ctx.home, std::path::PathBuf::from("/home/u"));
	assert_eq!(ctx.session_dir, Some(std::path::PathBuf::from("/sess")));
}

#[test]
fn session_context_none_when_root_missing() {
	let opts = pi_natives::code_path::napi::CodePathTaskOptions::default();
	assert!(opts.session_context().is_none());
}

#[test]
fn local_rejects_path_traversal() {
	let dir = TempDir::new().unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u").with_session_dir(dir.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "local".into(), path: "../etc/passwd".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(err.message.contains("escapes scheme root"), "diag: {}", err.message);
}

