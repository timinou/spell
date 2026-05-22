//! W1 integration: auto-registry populated from `crates/pi-natives/src/code_path/uri/`
//! resolves each declarative profile against fixture filesystems.
//!
//! Covers: skill, rule, memory, local (4 of the 5 simple profiles; pi:// covered
//! separately in w1b once docs embedding lands).


use pi_code_path::{
	UriLocator,
	resolver::traits::CancellationToken,
	scheme::SessionContext,
	scheme_dispatch::SchemeRegistry,
	types::Content,
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
	for expected in ["skill", "rule", "memory", "local"] {
		assert!(names.contains(&expected.to_string()), "missing {expected}");
	}
}

#[test]
fn skill_resolves() {
	let dir = TempDir::new().unwrap();
	let skill_md = dir.path().join(".spell/skills/canvas/SKILL.md");
	std::fs::create_dir_all(skill_md.parent().unwrap()).unwrap();
	std::fs::write(&skill_md, "# canvas skill\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "skill".into(), path: "canvas".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();

	assert_eq!(r.source_path, Some(skill_md));
	match &r.content {
		Content::Text { value } => assert!(value.contains("canvas skill")),
		_ => panic!("expected Text"),
	}
}

#[test]
fn skill_subpath_resolves() {
	let dir = TempDir::new().unwrap();
	let target = dir.path().join(".spell/skills/canvas/scripts/init.py");
	std::fs::create_dir_all(target.parent().unwrap()).unwrap();
	std::fs::write(&target, "print('hi')\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "skill".into(), path: "canvas/scripts/init.py".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(target));
}

#[test]
fn rule_resolves_with_ext_appended() {
	let dir = TempDir::new().unwrap();
	let rule_md = dir.path().join(".spell/rules/canvas-activation.md");
	std::fs::create_dir_all(rule_md.parent().unwrap()).unwrap();
	std::fs::write(&rule_md, "# canvas activation rule\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "rule".into(), path: "canvas-activation".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(rule_md));
}

#[test]
fn memory_resolves_root() {
	let dir = TempDir::new().unwrap();
	let mem_root = dir.path().join(".spell/memory/memory_summary.md");
	std::fs::create_dir_all(mem_root.parent().unwrap()).unwrap();
	std::fs::write(&mem_root, "# memory\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "memory".into(), path: "memory_summary.md".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert!(r.source_path.is_some());
}

#[test]
fn local_requires_session_dir() {
	let dir = TempDir::new().unwrap();
	// ctx without session_dir → local:// fails loudly
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
	std::fs::create_dir_all(dir.path().join(".spell/skills")).unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "skill".into(), path: "nonexistent".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(
		matches!(
			err.variant,
			pi_code_path::types::DiagnosticVariant::FileNotFound
		),
		"unexpected diagnostic variant: {:?}",
		err.variant
	);
}
