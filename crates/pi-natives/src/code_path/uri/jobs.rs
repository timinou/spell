use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `jobs://<job-id>[#fragment]` to job state files under
/// `<project_root>/.spell/jobs/<job-id>/`.
///
/// Supported fragments:
/// - (none)   → summary node (`§job`)
/// - `#status`  → `§status` text
/// - `#result`  → `§result` text
/// - `#error`   → `§error` text
/// - `#stderr`  → `§stderr` text (empty if absent)
/// - `#progress` → `§progress` text
pub struct JobsHandler {
	pub project_root: PathBuf,
}

impl JobsHandler {
	fn job_dir(&self, id: &str) -> PathBuf {
		self.project_root.join(".spell").join("jobs").join(id)
	}

	fn read_slot(&self, id: &str, filename: &str) -> Option<String> {
		let path = self.job_dir(id).join(filename);
		std::fs::read_to_string(path).ok()
	}
}

impl SchemeHandler for JobsHandler {
	fn scheme(&self) -> &'static str {
		"jobs"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let (id, fragment) = path.split_once('#').map_or((path, None), |(i, f)| (i, Some(f)));
		let dir = self.job_dir(id);

		if !dir.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::JobNotFound,
				message: format!("job not found: jobs://{path}"),
				span: None,
			});
		}

		match fragment {
			None => {
				let status = self.read_slot(id, "status.txt").unwrap_or_default();
				let result = self.read_slot(id, "result.txt");
				let error = self.read_slot(id, "error.txt");
				let mut summary = format!("status: {status}");
				if let Some(r) = result {
					summary.push('\n');
					summary.push_str(&r);
				}
				if let Some(e) = error {
					summary.push('\n');
					summary.push_str("error: ");
					summary.push_str(&e);
				}
				Ok(NodeRef {
					locator: format!("jobs://{path}"),
					range: 0..0,
					kind: "§job".into(),
					content: Some(Content::Text { value: summary }),
					metadata: Default::default(),
					diagnostics: vec![],
				})
			},
			Some("status") => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§status".into(),
				content: Some(Content::Text {
					value: self.read_slot(id, "status.txt").unwrap_or_default(),
				}),
				metadata: Default::default(),
				diagnostics: vec![],
			}),
			Some("result") => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§result".into(),
				content: Some(Content::Text {
					value: self.read_slot(id, "result.txt").unwrap_or_default(),
				}),
				metadata: Default::default(),
				diagnostics: vec![],
			}),
			Some("error") => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§error".into(),
				content: Some(Content::Text {
					value: self.read_slot(id, "error.txt").unwrap_or_default(),
				}),
				metadata: Default::default(),
				diagnostics: vec![],
			}),
			Some("stderr") => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§stderr".into(),
				content: Some(Content::Text {
					value: self.read_slot(id, "stderr.log").unwrap_or_default(),
				}),
				metadata: Default::default(),
				diagnostics: vec![],
			}),
			Some("progress") => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§progress".into(),
				content: Some(Content::Text {
					value: self.read_slot(id, "progress.txt").unwrap_or_default(),
				}),
				metadata: Default::default(),
				diagnostics: vec![],
			}),
			Some(other) => Ok(NodeRef {
				locator: format!("jobs://{path}"),
				range: 0..0,
				kind: "§job".into(),
				content: Some(Content::Text {
					value: format!("unknown fragment '{other}' for jobs://{id}"),
				}),
				metadata: Default::default(),
				diagnostics: vec![Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: format!("unknown jobs fragment: {other}"),
					span: None,
				}],
			}),
		}
	}
}
