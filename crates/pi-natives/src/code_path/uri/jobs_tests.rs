use std::io::Write;

use pi_code_path::{
	resolver::{CancellationToken, SchemeHandler},
	types::{Content, DiagnosticVariant},
};

use super::JobsHandler;

fn make_handler() -> (JobsHandler, tempfile::TempDir) {
	let dir = tempfile::tempdir().unwrap();
	let h = JobsHandler { project_root: dir.path().to_path_buf() };
	(h, dir)
}

fn write_job_file(root: &std::path::Path, id: &str, name: &str, content: &str) {
	let path = root.join(".spell").join("jobs").join(id);
	std::fs::create_dir_all(&path).unwrap();
	let mut f = std::fs::File::create(path.join(name)).unwrap();
	write!(f, "{content}").unwrap();
}

#[test]
fn jobs_status_returns_text() {
	let (h, dir) = make_handler();
	write_job_file(dir.path(), "j-123", "status.txt", "running");

	let node = h.handle("j-123#status", &CancellationToken::new()).unwrap();
	assert_eq!(node.locator, "jobs://j-123#status");
	assert_eq!(node.kind, "§status");
	assert_eq!(node.content, Some(Content::Text { value: "running".into() }));
}

#[test]
fn jobs_result_returns_text() {
	let (h, dir) = make_handler();
	write_job_file(dir.path(), "j-123", "result.txt", "hello world");

	let node = h.handle("j-123#result", &CancellationToken::new()).unwrap();
	assert_eq!(node.locator, "jobs://j-123#result");
	assert_eq!(node.kind, "§result");
	assert_eq!(node.content, Some(Content::Text { value: "hello world".into() }));
}

#[test]
fn jobs_nonexistent_returns_not_found() {
	let (h, _dir) = make_handler();
	let err = h
		.handle("missing-id", &CancellationToken::new())
		.unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::JobNotFound));
	assert!(err.message.contains("job not found"));
}

#[test]
fn jobs_zombie_state_returns_empty() {
	let (h, dir) = make_handler();
	let path = dir.path().join(".spell").join("jobs").join("zombie");
	std::fs::create_dir_all(&path).unwrap();

	let node = h
		.handle("zombie#status", &CancellationToken::new())
		.unwrap();
	assert_eq!(node.kind, "§status");
	assert_eq!(node.content, Some(Content::Text { value: "".into() }));
}

#[test]
fn jobs_default_returns_summary() {
	let (h, dir) = make_handler();
	write_job_file(dir.path(), "j-123", "status.txt", "done");
	write_job_file(dir.path(), "j-123", "result.txt", "ok");

	let node = h.handle("j-123", &CancellationToken::new()).unwrap();
	assert_eq!(node.locator, "jobs://j-123");
	assert_eq!(node.kind, "§job");
	match node.content {
		Some(Content::Text { value }) => {
			assert!(value.contains("status: done"));
			assert!(value.contains("ok"));
		},
		other => panic!("expected Text content, got {other:?}"),
	}
}

#[test]
fn jobs_stderr_empty_when_missing() {
	let (h, dir) = make_handler();
	let path = dir.path().join(".spell").join("jobs").join("j-456");
	std::fs::create_dir_all(&path).unwrap();

	let node = h.handle("j-456#stderr", &CancellationToken::new()).unwrap();
	assert_eq!(node.kind, "§stderr");
	assert_eq!(node.content, Some(Content::Text { value: "".into() }));
}

#[test]
fn jobs_error_returns_text() {
	let (h, dir) = make_handler();
	write_job_file(dir.path(), "j-123", "error.txt", "something broke");

	let node = h.handle("j-123#error", &CancellationToken::new()).unwrap();
	assert_eq!(node.kind, "§error");
	assert_eq!(node.content, Some(Content::Text { value: "something broke".into() }));
}

#[test]
fn jobs_progress_returns_text() {
	let (h, dir) = make_handler();
	write_job_file(dir.path(), "j-123", "progress.txt", "42%");

	let node = h
		.handle("j-123#progress", &CancellationToken::new())
		.unwrap();
	assert_eq!(node.kind, "§progress");
	assert_eq!(node.content, Some(Content::Text { value: "42%".into() }));
}
