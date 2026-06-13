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
	// PLAN-310 BUG-395: jobs:// is no longer a static profile (moved to
	// dynamic callback registration via AsyncJobManager at session start).
	for expected in ["agent", "artifact", "org"] {
		assert!(names.contains(&expected.to_string()), "missing {expected}");
	}
	assert!(!names.contains(&"jobs".to_string()), "jobs should be dynamic-only post BUG-395");
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

// PLAN-310 BUG-396: artifact:// moved to UserRoot + IndexLookup
// (mtime-cached cross-session scan). Tests moved to
// crates/pi-natives/tests/scheme_artifact_index.rs.

// ── jobs:// ──────────────────────────────────────────────────────

#[allow(dead_code)]
fn setup_job(root: &PathBuf, id: &str) {
	let job_dir = root.join(".spell/jobs").join(id);
	std::fs::create_dir_all(&job_dir).unwrap();
	std::fs::write(job_dir.join("status.txt"), "running").unwrap();
	std::fs::write(job_dir.join("result.txt"), "42").unwrap();
	std::fs::write(job_dir.join("error.txt"), "").unwrap();
	std::fs::write(job_dir.join("progress.txt"), "75%").unwrap();
}

#[test]
// PLAN-310 BUG-395: jobs:// moved to dynamic callback registration. Tests
// previously covering static-profile resolution (jobs_default_synthesizes_
// summary, jobs_fragment_selects_single_file, jobs_unknown_fragment_falls_
// back_to_default, jobs_unknown_id_returns_not_found) were removed; the new
// behavior is tested via the bun-test integration of AsyncJobManager.
// registerScheme.

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

#[test]
fn org_resolves_item_under_project_tasks() {
	let project = TempDir::new().unwrap();
	let cat_dir = project.path().join("!tasks/plans");
	std::fs::create_dir_all(&cat_dir).unwrap();
	let org_file = cat_dir.join("PLAN-cutover.org");
	std::fs::write(
		&org_file,
		"* TODO Cutover plan\n:PROPERTIES:\n:CUSTOM_ID: PLAN-310\n:END:\n\nPlan body here.\n",
	)
	.unwrap();

	let home = TempDir::new().unwrap();
	let ctx = SessionContext::new(project.path(), home.path());
	let reg = registry(Some(&ctx));
	let uri = UriLocator { scheme: "org".into(), path: "PLAN-310".into() };
	let cancel = CancellationToken::new();
	let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
	assert_eq!(r.source_path, Some(org_file));
	assert!(
		r.notes
			.iter()
			.any(|n| n.contains("Cutover plan") && n.contains("PLAN-310")),
		"expected title note, got: {:?}",
		r.notes
	);
}
