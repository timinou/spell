//! PLAN-310 BUG-396: artifact:// declarative profile with cross-session
//! index lookup. The TS handler scanned `~/.spell/agent/sessions/<project>/
//! <session-dir-with-_<hex>-suffix>/<agent>/<tool>/<file>`. The kernel
//! profile should do the same scan via an `IndexLookup` impl, with mtime-
//! cached results.
//!
//! These tests are RED before the artifact.rs rewrite and GREEN after.

use pi_code_path::{
	UriLocator,
	resolver::traits::CancellationToken,
	scheme::SessionContext,
	scheme_dispatch::SchemeRegistry,
	types::{Content, DiagnosticVariant},
};
use pi_natives::code_path::uri::SCHEME_FACTORIES;
use tempfile::TempDir;

/// Build a session-id-suffixed directory layout matching the TS
/// `getSessionsDir()` convention: <home>/.spell/agent/sessions/<project>/
/// <dir-name>_<hex-id>/<agent>/<tool>/<file>
fn make_session_dir(home: &std::path::Path, project: &str, name: &str, id: &str) -> std::path::PathBuf {
	let dir = home.join(format!(".spell/agent/sessions/{project}/{name}_{id}"));
	std::fs::create_dir_all(&dir).unwrap();
	dir
}

fn write_artifact(
	session_dir: &std::path::Path,
	agent: &str,
	tool: &str,
	filename: &str,
	content: &[u8],
) -> std::path::PathBuf {
	let path = session_dir.join(agent).join(tool).join(filename);
	std::fs::create_dir_all(path.parent().unwrap()).unwrap();
	std::fs::write(&path, content).unwrap();
	path
}

fn registry(ctx: Option<&SessionContext>) -> SchemeRegistry {
	SchemeRegistry::from_static(SCHEME_FACTORIES.iter().copied(), ctx)
}

#[test]
fn artifact_resolves_within_current_session_project() {
	let home = TempDir::new().unwrap();
	let project = TempDir::new().unwrap();
	let session_dir = make_session_dir(home.path(), "my-project", "session", "abc123def");
	let artifact_path = write_artifact(&session_dir, "main", "bash", "3.txt", b"command output\n");

	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "artifact".into(), path: "abc123def/main/bash/3.txt".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(artifact_path));
	match &r.content {
		Content::Text { value } => assert!(value.contains("command output")),
		_ => panic!("expected text content, got: {:?}", r.content),
	}
}

#[test]
fn artifact_resolves_across_project_dirs() {
	// Cross-session: artifact written by a SESSION owned by a different project.
	// Index must scan multiple project dirs to find the session by hex suffix.
	let home = TempDir::new().unwrap();
	let _other_session_unrelated = make_session_dir(home.path(), "proj-A", "older", "111aaa");
	let target_session = make_session_dir(home.path(), "proj-B", "review", "deadbeef");
	let target_artifact = write_artifact(&target_session, "reviewer_0", "get", "0.txt", b"REVIEWED");

	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));

	let uri = UriLocator { scheme: "artifact".into(), path: "deadbeef/reviewer_0/get/0.txt".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(target_artifact));
	match &r.content {
		Content::Text { value } => assert!(value.contains("REVIEWED")),
		_ => panic!("expected text"),
	}
}

#[test]
fn artifact_emits_binary_note_for_image_extensions() {
	let home = TempDir::new().unwrap();
	let session_dir = make_session_dir(home.path(), "p", "s", "abc999");
	let _png = write_artifact(&session_dir, "main", "bash", "5.png", &[0x89, b'P', b'N', b'G']);

	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "artifact".into(), path: "abc999/main/bash/5.png".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert!(
		r.notes.iter().any(|n| n.contains("Binary artifact") && n.contains("png")),
		"expected Binary artifact note, got: {:?}",
		r.notes
	);
}

#[test]
fn artifact_missing_session_returns_file_not_found() {
	let home = TempDir::new().unwrap();
	std::fs::create_dir_all(home.path().join(".spell/agent/sessions")).unwrap();
	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));

	let uri = UriLocator { scheme: "artifact".into(), path: "ghost-id/main/bash/0.txt".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
	assert!(err.message.contains("ghost-id"));
}

#[test]
fn artifact_malformed_body_returns_invalid() {
	let home = TempDir::new().unwrap();
	std::fs::create_dir_all(home.path().join(".spell/agent/sessions/p/x_abc")).unwrap();
	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));

	// Missing required path segments (needs <id>/<agent>/<tool>/<filename>).
	let uri = UriLocator { scheme: "artifact".into(), path: "only-id".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(err.message.to_lowercase().contains("agent") || err.message.to_lowercase().contains("path"));
}

#[test]
fn artifact_index_is_mtime_cached() {
	// Two consecutive lookups with no mtime change should reuse the cached
	// index. Adding a new session dir should invalidate.
	let home = TempDir::new().unwrap();
	let session_a = make_session_dir(home.path(), "p", "s1", "aaa111");
	let artifact_a = write_artifact(&session_a, "main", "bash", "0.txt", b"A");

	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let cancel = CancellationToken::new();

	let r1 = reg
		.resolve(
			&UriLocator { scheme: "artifact".into(), path: "aaa111/main/bash/0.txt".into() },
			Some(&ctx),
			&cancel,
		)
		.unwrap();
	assert_eq!(r1.source_path, Some(artifact_a.clone()));

	// Add a new session AND force the parent mtime to change.
	let session_b = make_session_dir(home.path(), "p", "s2", "bbb222");
	let artifact_b = write_artifact(&session_b, "main", "bash", "0.txt", b"B");
	// touch the sessions root to bump mtime — necessary because some FS may
	// not propagate child-dir mtime to parent immediately.
	let sessions_root = home.path().join(".spell/agent/sessions/p");
	let now = std::time::SystemTime::now() + std::time::Duration::from_secs(1);
	let _ = filetime::set_file_mtime(
		&sessions_root,
		filetime::FileTime::from_system_time(now),
	);

	let r2 = reg
		.resolve(
			&UriLocator { scheme: "artifact".into(), path: "bbb222/main/bash/0.txt".into() },
			Some(&ctx),
			&cancel,
		)
		.unwrap();
	assert_eq!(r2.source_path, Some(artifact_b));
}
