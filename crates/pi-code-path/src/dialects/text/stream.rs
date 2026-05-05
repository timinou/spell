//! Cross-file streaming for the text dialect.

use std::path::PathBuf;

use super::axes;
use crate::{
	ast::{Head, Step},
	resolver::traits::CancellationToken,
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

/// For each path in `paths`, read the file and apply the appropriate text
/// axis from `step`.  Cancellation is checked between files.
pub fn stream_files(paths: &[PathBuf], step: &Step, cancel: &CancellationToken) -> Vec<NodeRef> {
	let mut results = Vec::new();
	for path in paths {
		if cancel.is_cancelled() {
			break;
		}
		let content = match std::fs::read(path) {
			Ok(c) => c,
			Err(e) => {
				results.push(NodeRef {
					locator:     path.to_string_lossy().to_string(),
					range:       0..0,
					kind:        "§file".to_string(),
					content:     None,
					metadata:    std::collections::HashMap::new(),
					diagnostics: vec![Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("cannot read file: {e}"),
						span:    None,
					}],
				});
				continue;
			},
		};

		let mut nodes = match &step.head {
			Head::NodeKind(kind) => match kind.as_str() {
				"line" => axes::line_steps(&content, step),
				"para" => axes::para_steps(&content, step),
				"chunk" => axes::chunk_steps(&content, step),
				_ => axes::line_steps(&content, step),
			},
			_ => axes::line_steps(&content, step),
		};

		// Tag each node with its source file.
		for n in &mut nodes {
			n.locator = format!("{}::{}", path.to_string_lossy(), n.locator);
		}
		results.append(&mut nodes);
	}
	results
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ast::{Axis, Head, Predicate};

	#[test]
	fn stream_single_file() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("a.txt");
		std::fs::write(&path, b"foo\nbar\nbaz\n").unwrap();

		let step = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("line".to_string()),
			predicates: vec![],
		};
		let nodes = stream_files(&[PathBuf::from(&path)], &step, &CancellationToken::new());
		assert_eq!(nodes.len(), 3);
		assert!(nodes[0].locator.contains("line 1"));
		assert!(nodes[1].locator.contains("line 2"));
	}

	#[test]
	fn stream_with_predicate() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("a.txt");
		std::fs::write(&path, b"alpha\nbeta\ngamma\n").unwrap();

		let step = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("line".to_string()),
			predicates: vec![Predicate::TextMatch(r"^b".to_string())],
		};
		let nodes = stream_files(&[PathBuf::from(&path)], &step, &CancellationToken::new());
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].locator.contains("line 2"));
	}

	#[test]
	fn stream_missing_file() {
		let step = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("line".to_string()),
			predicates: vec![],
		};
		let nodes =
			stream_files(&[PathBuf::from("/nonexistent/file.txt")], &step, &CancellationToken::new());
		assert_eq!(nodes.len(), 1);
		assert!(
			nodes[0]
				.diagnostics
				.iter()
				.any(|d| matches!(d.variant, DiagnosticVariant::Inaccessible))
		);
	}

	#[test]
	fn stream_cancellation_stops_early() {
		let dir = tempfile::tempdir().unwrap();
		let p1 = dir.path().join("1.txt");
		let p2 = dir.path().join("2.txt");
		std::fs::write(&p1, b"a\n").unwrap();
		std::fs::write(&p2, b"b\n").unwrap();

		let cancel = CancellationToken::new();
		cancel.cancel();

		let step = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("line".to_string()),
			predicates: vec![],
		};
		let nodes = stream_files(&[PathBuf::from(&p1), PathBuf::from(&p2)], &step, &cancel);
		assert_eq!(nodes.len(), 0);
	}
}
