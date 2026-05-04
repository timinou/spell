use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::ast::{FsLocator, FsSegment};
use crate::types::NodeRef;

/// When an exact `FsLocator` resolves to zero nodes, fuzzy-match against the
/// project tree by basename.  If exactly **one** file matches, return it;
/// otherwise return `None`.
pub fn try_suffix_match(loc: &FsLocator, root: &Path) -> Option<NodeRef> {
	let pattern = fs_locator_to_string(loc);
	let basename = Path::new(&pattern).file_name()?.to_str()?;

	let mut matches = Vec::new();
	let walker = ignore::WalkBuilder::new(root).build();
	for entry in walker {
		if let Ok(ent) = entry {
			let path = ent.path();
			if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
				if name == basename {
					let rel = path.strip_prefix(root).ok()?;
					let kind = if ent.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
						"§dir"
					} else if ent.file_type().map(|ft| ft.is_symlink()).unwrap_or(false) {
						"§symlink"
					} else {
						"§file"
					};
					let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
					matches.push(NodeRef {
						locator:     rel.to_string_lossy().to_string(),
						range:       0..size as usize,
						kind:        kind.to_string(),
						content:     None,
						metadata:    HashMap::new(),
						diagnostics: Vec::new(),
					});
				}
			}
		}
	}

	if matches.len() == 1 {
		Some(matches.remove(0))
	} else {
		None
	}
}

fn fs_locator_to_string(loc: &FsLocator) -> String {
	let mut out = String::new();
	for seg in &loc.segments {
		match seg {
			FsSegment::Literal(s) => out.push_str(s),
			FsSegment::Star => out.push('*'),
			FsSegment::DoubleStar => out.push_str("**"),
			FsSegment::Question => out.push('?'),
			FsSegment::CharClass(chars) => {
				out.push('[');
				for c in chars {
					out.push(*c);
				}
				out.push(']');
			}
			FsSegment::Brace(items) => {
				out.push('{');
				out.push_str(&items.join(","));
				out.push('}');
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn suffix_fallback_exact_basename() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::create_dir(root.join("src/utils")).unwrap();
		fs::write(root.join("src/utils/foo.ts"), "").unwrap();

		let loc = FsLocator {
			segments: vec![FsSegment::Literal("foo.ts".to_string())],
		};
		let result = try_suffix_match(&loc, &root);
		assert!(result.is_some());
		assert_eq!(result.unwrap().locator, "src/utils/foo.ts");
	}

	#[test]
	fn suffix_fallback_ambiguous_returns_none() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("b")).unwrap();
		fs::write(root.join("a/foo.ts"), "").unwrap();
		fs::write(root.join("b/foo.ts"), "").unwrap();

		let loc = FsLocator {
			segments: vec![FsSegment::Literal("foo.ts".to_string())],
		};
		let result = try_suffix_match(&loc, &root);
		assert!(result.is_none());
	}

	#[test]
	fn suffix_fallback_zero_matches() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("bar.ts"), "").unwrap();

		let loc = FsLocator {
			segments: vec![FsSegment::Literal("foo.ts".to_string())],
		};
		let result = try_suffix_match(&loc, &root);
		assert!(result.is_none());
	}
}
