use std::path::Path;

use regex::Regex;

use crate::ast::{CompareOp, Predicate};
use crate::dialects::fs::anchors::{classify, anchor_name_matches};
use crate::resolver::traits::FsAnchorContext;
use crate::types::NodeRef;

/// Evaluate a `Predicate` against a filesystem `NodeRef`.
pub fn eval(pred: &Predicate, node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	match pred {
		Predicate::Ordinal(_) | Predicate::Range { .. } => {
			// Positional — caller pre-collects.
			true
		}
		Predicate::KindFilter(kind) => &node.kind == kind,
		Predicate::AnchorFilter(name) => {
			let anchors = classify(node, ctx);
			anchors.iter().any(|a| anchor_name_matches(*a, name))
		}
		Predicate::Attribute { name, value } => match name.as_str() {
			"ext" => {
				Path::new(&node.locator)
					.extension()
					.map(|e| e.to_str().unwrap_or("") == value)
					.unwrap_or(false)
			}
			"lang" => {
				Path::new(&node.locator)
					.extension()
					.map(|e| ctx.is_code_extension(e.to_str().unwrap_or("")))
					.unwrap_or(false)
			}
			"depth" => {
				let target: usize = value.parse().unwrap_or(0);
				node_depth(node) == target
			}
			"name" => {
				let basename = Path::new(&node.locator)
					.file_name()
					.and_then(|n| n.to_str())
					.unwrap_or("");
				glob_match(value, basename)
			}
			_ => false,
		},
		Predicate::Compare { name, op, value } => match name.as_str() {
			"size" => compare_size(op, value, node, ctx),
			"mtime" => compare_mtime(op, value, node, ctx),
			"depth" => compare_depth(op, value, node),
			_ => false,
		},
		Predicate::Flag(name) => match name.as_str() {
			"empty" => is_empty(node, ctx),
			"text" => !is_binary(node, ctx),
			_ => false,
		},
		Predicate::TextMatch(re) => text_match(re, node, ctx),
		Predicate::LiteralMatch(s) => literal_match(s, node, ctx),
		Predicate::Length { op, value } => {
			let size = file_size(node, ctx).unwrap_or(0);
			compare_u64(op, size, *value)
		}
		Predicate::Count { kind: _, op, value } => {
			compare_u64(op, 0, *value)
		}
		_ => false,
	}
}

fn node_depth(node: &NodeRef) -> usize {
	node.locator.matches('/').count()
}

fn abs_path(node: &NodeRef, ctx: &dyn FsAnchorContext) -> Option<std::path::PathBuf> {
	ctx.root().map(|r| r.join(&node.locator))
}

fn file_size(node: &NodeRef, ctx: &dyn FsAnchorContext) -> Option<u64> {
	abs_path(node, ctx)?.metadata().ok().map(|m| m.len())
}

fn file_mtime(node: &NodeRef, ctx: &dyn FsAnchorContext) -> Option<std::time::SystemTime> {
	abs_path(node, ctx)?.metadata().ok().and_then(|m| m.modified().ok())
}

fn is_empty(node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	match node.kind.as_str() {
		"§file" => file_size(node, ctx).unwrap_or(1) == 0,
		"§dir" => {
			if let Some(path) = abs_path(node, ctx) {
				std::fs::read_dir(path).map(|mut d| d.next().is_none()).unwrap_or(false)
			} else {
				false
			}
		}
		_ => false,
	}
}

fn is_binary(node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	if node.kind != "§file" {
		return false;
	}
	let Some(path) = abs_path(node, ctx) else {
		return false;
	};
	let Ok(meta) = std::fs::metadata(&path) else {
		return true;
	};
	let size = meta.len();
	if size == 0 {
		return false;
	}
	let max = std::cmp::min(size as usize, 8192);
	match std::fs::read(&path) {
		Ok(data) => {
			let sample = &data[..max];
			std::str::from_utf8(sample).is_err()
		}
		Err(_) => true,
	}
}

fn text_match(re: &str, node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	let Some(path) = abs_path(node, ctx) else {
		return false;
	};
	let Ok(content) = std::fs::read_to_string(&path) else {
		return false;
	};
	let Ok(regex) = Regex::new(re) else {
		return false;
	};
	regex.is_match(&content)
}

fn literal_match(s: &str, node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	let Some(path) = abs_path(node, ctx) else {
		return false;
	};
	let Ok(content) = std::fs::read_to_string(&path) else {
		return false;
	};
	content.contains(s)
}

fn parse_size(s: &str) -> u64 {
	let s = s.trim().to_uppercase();
	if let Some(prefix) = s.strip_suffix('G') {
		prefix.parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024
	} else if let Some(prefix) = s.strip_suffix('M') {
		prefix.parse::<u64>().unwrap_or(0) * 1024 * 1024
	} else if let Some(prefix) = s.strip_suffix('K') {
		prefix.parse::<u64>().unwrap_or(0) * 1024
	} else {
		s.parse::<u64>().unwrap_or(0)
	}
}

fn parse_mtime(s: &str) -> Option<std::time::SystemTime> {
	let s = s.trim();
	// Try YYYY-MM-DD first
	if s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
		let year: i32 = s[..4].parse().ok()?;
		let month: u32 = s[5..7].parse().ok()?;
		let day: u32 = s[8..10].parse().ok()?;
		let dt = chrono::NaiveDate::from_ymd_opt(year, month, day)?
			.and_hms_opt(0, 0, 0)?;
		let unix = dt.and_utc().timestamp();
		return Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix as u64));
	}
	// Try RFC3339
	if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
		let unix = dt.timestamp();
		return Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix as u64));
	}
	None
}

fn compare_size(op: &CompareOp, value_str: &str, node: &NodeRef, ctx: &dyn FsAnchorContext) -> bool {
	let target = parse_size(value_str);
	let actual = file_size(node, ctx).unwrap_or(0);
	match op {
		CompareOp::Gt => actual > target,
		CompareOp::Lt => actual < target,
		CompareOp::Gte => actual >= target,
		CompareOp::Lte => actual <= target,
		CompareOp::Eq => actual == target,
		CompareOp::Neq => actual != target,
	}
}

fn compare_mtime(
	op: &CompareOp,
	value_str: &str,
	node: &NodeRef,
	ctx: &dyn FsAnchorContext,
) -> bool {
	let target = parse_mtime(value_str);
	let actual = file_mtime(node, ctx);
	match (target, actual) {
		(Some(t), Some(a)) => match op {
			CompareOp::Gt => a > t,
			CompareOp::Lt => a < t,
			CompareOp::Gte => a >= t,
			CompareOp::Lte => a <= t,
			CompareOp::Eq => a == t,
			CompareOp::Neq => a != t,
		},
		_ => false,
	}
}

fn compare_depth(op: &CompareOp, value_str: &str, node: &NodeRef) -> bool {
	let target: usize = value_str.parse().unwrap_or(0);
	let actual = node_depth(node);
	match op {
		CompareOp::Gt => actual > target,
		CompareOp::Lt => actual < target,
		CompareOp::Gte => actual >= target,
		CompareOp::Lte => actual <= target,
		CompareOp::Eq => actual == target,
		CompareOp::Neq => actual != target,
	}
}

fn compare_u64(op: &CompareOp, actual: u64, target: u64) -> bool {
	match op {
		CompareOp::Gt => actual > target,
		CompareOp::Lt => actual < target,
		CompareOp::Gte => actual >= target,
		CompareOp::Lte => actual <= target,
		CompareOp::Eq => actual == target,
		CompareOp::Neq => actual != target,
	}
}

fn glob_match(pattern: &str, text: &str) -> bool {
	match globset::Glob::new(pattern) {
		Ok(glob) => {
			let mut builder = globset::GlobSetBuilder::new();
			builder.add(glob);
			if let Ok(set) = builder.build() {
				return set.is_match(text);
			}
			false
		}
		Err(_) => text == pattern,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	use crate::dialects::fs::anchors::DefaultFsAnchorContext;

	fn ctx(root: std::path::PathBuf) -> DefaultFsAnchorContext {
		DefaultFsAnchorContext::new(root)
	}

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
	fn predicate_kind_filter() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("src/main.rs", "§file");
		assert!(eval(&Predicate::KindFilter("§file".to_string()), &n, &ctx(dir.path().to_path_buf())));
		assert!(!eval(&Predicate::KindFilter("§dir".to_string()), &n, &ctx(dir.path().to_path_buf())));
	}

	#[test]
	fn predicate_anchor_filter() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join(".env"), "").unwrap();
		let n = node(".env", "§file");
		assert!(eval(
			&Predicate::AnchorFilter("hidden".to_string()),
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_attribute_ext() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("main.rs", "§file");
		assert!(eval(
			&Predicate::Attribute {
				name:  "ext".to_string(),
				value: "rs".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_attribute_lang() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("main.rs", "§file");
		assert!(eval(
			&Predicate::Attribute {
				name:  "lang".to_string(),
				value: "rust".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_attribute_depth() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("a/b/c.rs", "§file");
		assert!(eval(
			&Predicate::Attribute {
				name:  "depth".to_string(),
				value: "2".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_attribute_name_glob() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("src/utils/helper.ts", "§file");
		assert!(eval(
			&Predicate::Attribute {
				name:  "name".to_string(),
				value: "*.ts".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_compare_size() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("big.rs"), vec![0u8; 500]).unwrap();
		let n = node("big.rs", "§file");
		assert!(eval(
			&Predicate::Compare {
				name:  "size".to_string(),
				op:    CompareOp::Gt,
				value: "100".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_compare_size_k() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("file.rs"), vec![0u8; 1500]).unwrap();
		let n = node("file.rs", "§file");
		assert!(eval(
			&Predicate::Compare {
				name:  "size".to_string(),
				op:    CompareOp::Gt,
				value: "1K".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_compare_size_m() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("file.rs"), vec![0u8; 1_100_000]).unwrap();
		let n = node("file.rs", "§file");
		assert!(eval(
			&Predicate::Compare {
				name:  "size".to_string(),
				op:    CompareOp::Gt,
				value: "1M".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_compare_mtime_shorthand() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("old.rs"), "").unwrap();
		let n = node("old.rs", "§file");
		assert!(eval(
			&Predicate::Compare {
				name:  "mtime".to_string(),
				op:    CompareOp::Lt,
				value: "2100-01-01".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_compare_depth() {
		let dir = tempfile::tempdir().unwrap();
		let n = node("a/b.rs", "§file");
		assert!(eval(
			&Predicate::Compare {
				name:  "depth".to_string(),
				op:    CompareOp::Eq,
				value: "1".to_string(),
			},
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_flag_empty_file() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("empty.rs"), "").unwrap();
		let n = node("empty.rs", "§file");
		assert!(eval(
			&Predicate::Flag("empty".to_string()),
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_flag_text() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("hello.rs"), "fn main() {}").unwrap();
		let n = node("hello.rs", "§file");
		assert!(eval(
			&Predicate::Flag("text".to_string()),
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_text_match() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("code.rs"), "fn main() { println!(); }").unwrap();
		let n = node("code.rs", "§file");
		assert!(eval(
			&Predicate::TextMatch("println".to_string()),
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}

	#[test]
	fn predicate_literal_match() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("code.rs"), "fn main() {}").unwrap();
		let n = node("code.rs", "§file");
		assert!(eval(
			&Predicate::LiteralMatch("fn main".to_string()),
			&n,
			&ctx(dir.path().to_path_buf()),
		));
	}
}
