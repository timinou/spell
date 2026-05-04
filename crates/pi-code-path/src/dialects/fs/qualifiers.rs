use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::ast::Qualifier;
use crate::types::{Diagnostic, DiagnosticVariant, NodeRef};

/// Resolve an FS qualifier for the given node.
///
/// `#listing` returns one-level children.  `#tree[depth=N]` returns a
/// recursive listing capped at depth *N*.  `#stat` returns metadata.
pub fn resolve(
	node: &NodeRef,
	qual: &Qualifier,
	root: &Path,
) -> Result<Vec<NodeRef>, Diagnostic> {
	match qual.name.as_str() {
		"listing" => resolve_listing(node, root),
		"tree" => resolve_tree(node, qual.args.as_deref(), root),
		"stat" => resolve_stat(node, root),
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("unknown qualifier: {}", qual.name),
			span:    None,
		}),
	}
}

fn resolve_listing(node: &NodeRef, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	let path = Path::new(&node.locator);
	let full_path = resolve_full_path(path, root);

	let entries = std::fs::read_dir(&full_path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot read directory: {e}"),
		span:    None,
	})?;

	let mut nodes = Vec::new();
	for entry in entries {
		let entry = entry.map_err(|e| Diagnostic {
			variant: DiagnosticVariant::Inaccessible,
			message: format!("directory entry error: {e}"),
			span:    None,
		})?;
		let name = entry.file_name().to_string_lossy().to_string();
		let meta = entry.metadata().map_err(|e| Diagnostic {
			variant: DiagnosticVariant::Inaccessible,
			message: format!("metadata error: {e}"),
			span:    None,
		})?;
		let kind = if meta.is_dir() {
			"§dir".to_string()
		} else if meta.is_symlink() {
			"§symlink".to_string()
		} else {
			"§file".to_string()
		};
		let child_path = path.join(&name);
		let locator = child_path.to_string_lossy().to_string();
		let size = meta.len();
		nodes.push(NodeRef {
			locator,
			range:       0..size as usize,
			kind,
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		});
	}
	Ok(nodes)
}

fn resolve_tree(
	node: &NodeRef,
	args: Option<&str>,
	root: &Path,
) -> Result<Vec<NodeRef>, Diagnostic> {
	let max_depth = args
		.and_then(|s| {
			s.strip_prefix("depth=")
				.or_else(|| s.strip_prefix("depth = "))
				.and_then(|n| n.parse::<usize>().ok())
		})
		.unwrap_or(usize::MAX);

	let base = Path::new(&node.locator);
	let mut results = Vec::new();
	let mut stack = vec![(base.to_path_buf(), 0usize)];

	while let Some((path, depth)) = stack.pop() {
		if depth > max_depth {
			continue;
		}

		let full_path = resolve_full_path(&path, root);

		let meta = std::fs::metadata(&full_path).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::Inaccessible,
			message: format!("metadata error: {e}"),
			span:    None,
		})?;

		let kind = if meta.is_dir() {
			"§dir".to_string()
		} else if meta.is_symlink() {
			"§symlink".to_string()
		} else {
			"§file".to_string()
		};

		let size = meta.len();
		results.push(NodeRef {
			locator:     path.to_string_lossy().to_string(),
			range:       0..size as usize,
			kind,
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		});

		if meta.is_dir() && depth < max_depth {
			let entries = std::fs::read_dir(&full_path).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: format!("read_dir error: {e}"),
				span:    None,
			})?;
			for entry in entries {
				let entry = entry.map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("directory entry error: {e}"),
					span:    None,
				})?;
				let name = entry.file_name();
				let child_path = path.join(&name);
				stack.push((child_path, depth + 1));
			}
		}
	}

	Ok(results)
}

fn resolve_stat(node: &NodeRef, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	let path = Path::new(&node.locator);
	let full_path = resolve_full_path(path, root);

	let meta = std::fs::metadata(&full_path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("metadata error: {e}"),
		span:    None,
	})?;

	let kind = if meta.is_dir() {
		"§dir".to_string()
	} else if meta.is_symlink() {
		"§symlink".to_string()
	} else {
		"§file".to_string()
	};

	let size = meta.len();
	let mtime = meta.modified().ok();

	let mut metadata = HashMap::new();
	metadata.insert(
		"size".to_string(),
		serde_json::Value::Number(size.into()),
	);
	if let Some(t) = mtime {
		let secs = t
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_secs();
		metadata.insert("mtime".to_string(), serde_json::Value::Number(secs.into()));
	}
	metadata.insert("kind".to_string(), serde_json::Value::String(kind.clone()));

	let mut node = node.clone();
	node.metadata = metadata;
	node.kind = kind;
	node.range = 0..size as usize;

	Ok(vec![node])
}

fn resolve_full_path(path: &Path, root: &Path) -> PathBuf {
	if path.is_absolute() {
		path.to_path_buf()
	} else {
		root.join(path)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	fn node(locator: &str, kind: &str) -> NodeRef {
		NodeRef {
			locator:     locator.to_string(),
			range:       0..0,
			kind:        kind.to_string(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: vec![],
		}
	}

	#[test]
	fn qualifier_listing_one_level() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();
		fs::write(root.join("src/b.rs"), "").unwrap();

		let n = node("src", "§dir");
		let qual = Qualifier {
			name: "listing".to_string(),
			args: None,
		};
		let children = resolve(&n, &qual, &root).unwrap();
		assert_eq!(children.len(), 2);
		assert!(children.iter().any(|c| c.locator == "src/a.rs"));
		assert!(children.iter().any(|c| c.locator == "src/b.rs"));
	}

	#[test]
	fn qualifier_tree_depth_capped() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("a/b")).unwrap();
		fs::write(root.join("a/b/c.rs"), "").unwrap();

		let n = node("a", "§dir");
		let qual = Qualifier {
			name: "tree".to_string(),
			args: Some("depth=1".to_string()),
		};
		let results = resolve(&n, &qual, &root).unwrap();
		let locators: Vec<_> = results.iter().map(|r| r.locator.clone()).collect();
		assert!(locators.contains(&"a".to_string()));
		assert!(locators.contains(&"a/b".to_string()));
		assert!(!locators.contains(&"a/b/c.rs".to_string()));
	}

	#[test]
	fn qualifier_stat_metadata() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("file.rs"), "hello").unwrap();

		let n = node("file.rs", "§file");
		let qual = Qualifier {
			name: "stat".to_string(),
			args: None,
		};
		let results = resolve(&n, &qual, &root).unwrap();
		assert_eq!(results.len(), 1);
		let meta = &results[0].metadata;
		assert!(meta.contains_key("size"));
		assert!(meta.contains_key("mtime"));
		assert_eq!(
			meta.get("kind"),
			Some(&serde_json::Value::String("§file".to_string()))
		);
	}
}
