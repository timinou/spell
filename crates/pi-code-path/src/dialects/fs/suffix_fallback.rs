use std::{
	collections::{HashMap, HashSet},
	path::{Path, PathBuf},
};

use crate::{
	ast::{FsLocator, FsSegment},
	types::NodeRef,
};

/// Result of the suffix-fallback fuzzy matcher.
#[derive(Debug)]
pub enum SuffixFallbackResult {
	/// Exactly one file matched.
	Match(NodeRef),
	/// More than one file matched; sorted lexicographically.
	Ambiguous(Vec<PathBuf>),
	/// Zero files matched.
	NotFound,
}

/// When an exact `FsLocator` resolves to zero nodes, fuzzy-match against the
/// project tree by basename.
pub fn try_suffix_match(loc: &FsLocator, root: &Path) -> SuffixFallbackResult {
	let pattern = fs_locator_to_string(loc);
	let Some(basename) = Path::new(&pattern).file_name().and_then(|n| n.to_str()) else {
		return SuffixFallbackResult::NotFound;
	};

	let mut seen: HashSet<PathBuf> = HashSet::new();
	let mut matches: Vec<(PathBuf, NodeRef)> = Vec::new();
	let walker = ignore::WalkBuilder::new(root).build();
	for entry in walker {
		let Ok(ent) = entry else { continue };
		let path = ent.path();
		let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
			continue;
		};
		if name != basename {
			continue;
		}
		let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
		if !seen.insert(canon) {
			continue;
		}
		let rel = path.strip_prefix(root).unwrap_or(path);
		let kind = if ent.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
			"§dir"
		} else if ent.file_type().map(|ft| ft.is_symlink()).unwrap_or(false) {
			"§symlink"
		} else {
			"§file"
		};
		let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
		matches.push((rel.to_path_buf(), NodeRef {
			locator:     rel.to_string_lossy().to_string(),
			range:       0..size as usize,
			kind:        kind.to_string(),
			content:     None,
			metadata:    HashMap::new(),
			diagnostics: Vec::new(),
		}));
	}

	if matches.len() == 1 {
		SuffixFallbackResult::Match(matches.into_iter().next().unwrap().1)
	} else if matches.len() > 1 {
		matches.sort_by(|a, b| a.0.cmp(&b.0));
		let candidates: Vec<PathBuf> = matches.into_iter().map(|(p, _)| p).collect();
		SuffixFallbackResult::Ambiguous(candidates)
	} else {
		SuffixFallbackResult::NotFound
	}
}

pub(crate) fn fs_locator_to_string(loc: &FsLocator) -> String {
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
			},
			FsSegment::Brace(items) => {
				out.push('{');
				out.push_str(&items.join(","));
				out.push('}');
			},
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn suffix_fallback_exact_basename() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir_all(root.join("src/utils")).unwrap();
		fs::write(root.join("src/utils/foo.ts"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("foo.ts".to_string())] };
		let result = try_suffix_match(&loc, &root);
		match result {
			SuffixFallbackResult::Match(node) => {
				assert_eq!(node.locator, "src/utils/foo.ts");
			},
			_ => panic!("expected Match, got {:?}", result),
		}
	}

	#[test]
	fn suffix_fallback_ambiguous() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("b")).unwrap();
		fs::write(root.join("a/foo.ts"), "").unwrap();
		fs::write(root.join("b/foo.ts"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("foo.ts".to_string())] };
		let result = try_suffix_match(&loc, &root);
		match result {
			SuffixFallbackResult::Ambiguous(candidates) => {
				assert_eq!(candidates.len(), 2);
				assert!(candidates.iter().any(|p| p.ends_with("a/foo.ts")));
				assert!(candidates.iter().any(|p| p.ends_with("b/foo.ts")));
			},
			_ => panic!("expected Ambiguous, got {:?}", result),
		}
	}

	#[test]
	fn suffix_fallback_zero_matches() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("bar.ts"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("foo.ts".to_string())] };
		let result = try_suffix_match(&loc, &root);
		assert!(
			matches!(result, SuffixFallbackResult::NotFound),
			"expected NotFound, got {:?}",
			result
		);
	}

	#[test]
	fn suffix_fallback_more_than_five() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..7 {
			let sub = root.join(format!("d{}", i));
			fs::create_dir(&sub).unwrap();
			fs::write(sub.join("index.ts"), "").unwrap();
		}
		let loc = FsLocator { segments: vec![FsSegment::Literal("index.ts".to_string())] };
		let result = try_suffix_match(&loc, &root);
		match result {
			SuffixFallbackResult::Ambiguous(candidates) => {
				assert_eq!(candidates.len(), 7);
				// Lexicographic order of relative paths
				let mut sorted = candidates.clone();
				sorted.sort();
				assert_eq!(candidates, sorted);
			},
			_ => panic!("expected Ambiguous, got {:?}", result),
		}
	}
}
