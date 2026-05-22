//! W3 integration: rich profiles (agent, artifact, jobs, org).

use std::path::PathBuf;

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
fn w3_profiles_present() {
	let reg = registry(None);
	let names = reg.known_schemes();
	for expected in ["agent", "artifact", "jobs", "org"] {
		assert!(names.contains(&expected.to_string()), "missing {expected}");
	}
}

// ── agent:// ─────────────────────────────────────────────────────

#[test]
fn agent_resolves_session_md_file() {
	let dir = TempDir::new().unwrap();
	let sess = dir.path().join("session-abc");
	std::fs::create_dir_all(&sess).unwrap();
	std::fs::write(sess.join("reviewer_0.md"), "review output\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u").with_session_dir(&sess);
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "agent".into(), path: "reviewer_0".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(sess.join("reviewer_0.md")));
	match &r.content {
		Content::Text { value } => assert!(value.contains("review output")),
		_ => panic!("expected Text"),
	}
}

#[test]
fn agent_requires_session_dir() {
	let dir = TempDir::new().unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "agent".into(), path: "x".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(err.message.contains("SessionRoot"));
}

// ── artifact:// ──────────────────────────────────────────────────

#[test]
fn artifact_resolves_multi_segment_body() {
	let dir = TempDir::new().unwrap();
	let target = dir.path().join(".spell/sessions/abc123/reviewer/get/3.txt");
	std::fs::create_dir_all(target.parent().unwrap()).unwrap();
	std::fs::write(&target, "artifact content\n").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "artifact".into(), path: "abc123/reviewer/get/3.txt".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(target));
	match &r.content {
		Content::Text { value } => assert!(value.contains("artifact content")),
		_ => panic!("expected Text"),
	}
}

// ── jobs:// ──────────────────────────────────────────────────────

fn setup_job(root: &PathBuf, id: &str) {
	let job_dir = root.join(".spell/jobs").join(id);
	std::fs::create_dir_all(&job_dir).unwrap();
	std::fs::write(job_dir.join("status.txt"), "running").unwrap();
	std::fs::write(job_dir.join("result.txt"), "42").unwrap();
	std::fs::write(job_dir.join("error.txt"), "").unwrap();
	std::fs::write(job_dir.join("progress.txt"), "75%").unwrap();
}

#[test]
fn jobs_default_synthesizes_summary() {
	let dir = TempDir::new().unwrap();
	let root = dir.path().to_path_buf();
	setup_job(&root, "job-1");

	let ctx = SessionContext::new(&root, "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "jobs".into(), path: "job-1".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	match &r.content {
		Content::Text { value } => {
			assert!(value.contains("status: running"));
			assert!(value.contains("result: 42"));
			assert!(value.contains("progress: 75%"));
		},
		_ => panic!("expected Text"),
	}
}

#[test]
fn jobs_fragment_selects_single_file() {
	let dir = TempDir::new().unwrap();
	let root = dir.path().to_path_buf();
	setup_job(&root, "job-2");

	let ctx = SessionContext::new(&root, "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "jobs".into(), path: "job-2#status".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	match &r.content {
		Content::Text { value } => assert_eq!(value, "running"),
		_ => panic!("expected Text"),
	}
}

#[test]
fn jobs_unknown_fragment_falls_back_to_default() {
	let dir = TempDir::new().unwrap();
	let root = dir.path().to_path_buf();
	setup_job(&root, "job-3");

	let ctx = SessionContext::new(&root, "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "jobs".into(), path: "job-3#unknown".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	match &r.content {
		Content::Text { value } => {
			// Falls back to default Synth
			assert!(value.contains("status:"));
		},
		_ => panic!("expected Text"),
	}
}

#[test]
fn jobs_unknown_id_returns_not_found() {
	let dir = TempDir::new().unwrap();
	std::fs::create_dir_all(dir.path().join(".spell/jobs")).unwrap();
	let ctx = SessionContext::new(dir.path(), "/home/u");
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "jobs".into(), path: "no-such-job".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(matches!(err.variant, pi_code_path::types::DiagnosticVariant::FileNotFound));
}

// ── org:// ───────────────────────────────────────────────────────

#[test]
fn org_resolves_item_by_id() {
	let home = TempDir::new().unwrap();
	let cat_dir = home.path().join(".org/features");
	std::fs::create_dir_all(&cat_dir).unwrap();
	let org_file = cat_dir.join("FEAT-foo.org");
	std::fs::write(
		&org_file,
		"#+TITLE: foo\n#+CUSTOM_ID: TOPLEVEL\n\n* TODO Implement [#A] \
		 :feature:\n:PROPERTIES:\n:CUSTOM_ID: FEAT-123\n:END:\n\nThe body.\n",
	)
	.unwrap();

	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "org".into(), path: "FEAT-123".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(org_file));
	match &r.content {
		Content::Text { value } => {
			assert!(value.contains("Implement"));
			assert!(value.contains("The body"));
		},
		_ => panic!("expected Text"),
	}
}

#[test]
fn org_unknown_id_returns_not_found() {
	let home = TempDir::new().unwrap();
	std::fs::create_dir_all(home.path().join(".org/features")).unwrap();
	let project = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "org".into(), path: "FEAT-doesnt-exist".into() };
	let cancel = CancellationToken::new();
	let err = reg.resolve(&uri, Some(&ctx), &cancel).unwrap_err();
	assert!(matches!(err.variant, pi_code_path::types::DiagnosticVariant::FileNotFound));
}
