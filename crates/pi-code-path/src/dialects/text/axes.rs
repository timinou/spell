//! Axis-step resolution for the text dialect.
//!
//! `§line`, `§para`, and `§chunk` are the supported node-kind heads.

use std::collections::HashMap;

use regex::Regex;

use super::{line_index::LineIndex, para_index::ParaIndex};
use crate::{
	ast::{CompareOp, Predicate, Step},
	types::{Content, NodeRef},
};

// ── §line ────────────────────────────────────────────────────────

/// Apply a `§line` step to `content`.
pub fn line_steps(content: &[u8], step: &Step) -> Vec<NodeRef> {
	let line_index = LineIndex::build(content);
	let text = String::from_utf8_lossy(content);
	let mut selected: Vec<usize> = (1..=line_index.line_count()).collect();

	for pred in &step.predicates {
		selected.retain(|ln| line_predicate(pred, *ln, content, &line_index, &text));
	}

	selected
		.into_iter()
		.map(|ln| {
			let range = line_index.line_range(ln, content.len()).unwrap_or(0..0);
			let line_text = text[range.clone()].to_string();
			NodeRef {
				locator: format!("<line {}>", ln),
				range,
				kind: "§line".to_string(),
				content: Some(Content::Text { value: line_text }),
				metadata: HashMap::new(),
				diagnostics: Vec::new(),
			}
		})
		.collect()
}

fn line_predicate(
	pred: &Predicate,
	line_num: usize,
	content: &[u8],
	line_index: &LineIndex,
	text: &str,
) -> bool {
	match pred {
		Predicate::Range { start, end } => {
			let count = line_index.line_count() as isize;
			let s = start
				.map(|v| if v < 0 { count + v + 1 } else { v.max(1) })
				.unwrap_or(1);
			let e = end
				.map(|v| if v < 0 { count + v + 1 } else { v })
				.unwrap_or(count);
			let idx = line_num as isize;
			idx >= s && idx <= e
		},
		Predicate::Ordinal(n) => {
			let count = line_index.line_count() as isize;
			let target = if *n < 0 { count + *n + 1 } else { *n };
			(line_num as isize) == target
		},
		Predicate::TextMatch(pattern) => {
			let range = line_index
				.line_range(line_num, content.len())
				.unwrap_or(0..0);
			let line_text = &text[range];
			Regex::new(pattern)
				.map(|re| re.is_match(line_text))
				.unwrap_or(false)
		},
		Predicate::LiteralMatch(lit) => {
			let range = line_index
				.line_range(line_num, content.len())
				.unwrap_or(0..0);
			let line_text = &text[range];
			line_text.contains(lit)
		},
		Predicate::Compare { name, op, value } => {
			if name != "len" {
				return false;
			}
			let range = line_index
				.line_range(line_num, content.len())
				.unwrap_or(0..0);
			let len = range.end.saturating_sub(range.start) as u64;
			let target = value.parse::<u64>().unwrap_or(0);
			compare_u64(op, len, target)
		},
		Predicate::Flag(name) => match name.as_str() {
			"empty" => {
				let range = line_index
					.line_range(line_num, content.len())
					.unwrap_or(0..0);
				let line_text = &text[range];
				line_text.trim().is_empty()
			},
			"last" => line_num == line_index.line_count(),
			_ => false,
		},
		_ => true,
	}
}

// ── §para ────────────────────────────────────────────────────────

/// Apply a `§para` step to `content`.
pub fn para_steps(content: &[u8], step: &Step) -> Vec<NodeRef> {
	let para_index = ParaIndex::build(content);
	let text = String::from_utf8_lossy(content);
	let mut selected: Vec<usize> = (1..=para_index.para_count()).collect();

	for pred in &step.predicates {
		selected.retain(|pn| para_predicate(pred, *pn, content, &para_index, &text));
	}

	selected
		.into_iter()
		.map(|pn| {
			let range = para_index.para_range(pn, content.len()).unwrap_or(0..0);
			let para_text = text[range.clone()].to_string();
			NodeRef {
				locator: format!("<para {}>", pn),
				range,
				kind: "§para".to_string(),
				content: Some(Content::Text { value: para_text }),
				metadata: HashMap::new(),
				diagnostics: Vec::new(),
			}
		})
		.collect()
}

fn para_predicate(
	pred: &Predicate,
	para_num: usize,
	content: &[u8],
	para_index: &ParaIndex,
	text: &str,
) -> bool {
	match pred {
		Predicate::Range { start, end } => {
			let count = para_index.para_count() as isize;
			let s = start
				.map(|v| if v < 0 { count + v + 1 } else { v.max(1) })
				.unwrap_or(1);
			let e = end
				.map(|v| if v < 0 { count + v + 1 } else { v })
				.unwrap_or(count);
			let idx = para_num as isize;
			idx >= s && idx <= e
		},
		Predicate::Ordinal(n) => {
			let count = para_index.para_count() as isize;
			let target = if *n < 0 { count + *n + 1 } else { *n };
			(para_num as isize) == target
		},
		Predicate::TextMatch(pattern) => {
			let range = para_index
				.para_range(para_num, content.len())
				.unwrap_or(0..0);
			let para_text = &text[range];
			Regex::new(pattern)
				.map(|re| re.is_match(para_text))
				.unwrap_or(false)
		},
		Predicate::LiteralMatch(lit) => {
			let range = para_index
				.para_range(para_num, content.len())
				.unwrap_or(0..0);
			let para_text = &text[range];
			para_text.contains(lit)
		},
		Predicate::Compare { name, op, value } => {
			if name != "len" {
				return false;
			}
			let range = para_index
				.para_range(para_num, content.len())
				.unwrap_or(0..0);
			let len = range.end.saturating_sub(range.start) as u64;
			let target = value.parse::<u64>().unwrap_or(0);
			compare_u64(op, len, target)
		},
		Predicate::Flag(name) => match name.as_str() {
			"last" => para_num == para_index.para_count(),
			_ => false,
		},
		_ => true,
	}
}

// ── §chunk ───────────────────────────────────────────────────────

/// Apply a `§chunk` step to `content`.
///
/// Chunk size defaults to 50 lines and can be overridden by a predicate:
/// `[n=20]` (Attribute) or `[n==20]` / `[n=20]` (Compare with Eq).
pub fn chunk_steps(content: &[u8], step: &Step) -> Vec<NodeRef> {
	let line_index = LineIndex::build(content);
	let text = String::from_utf8_lossy(content);
	let line_count = line_index.line_count();
	let chunk_size = parse_chunk_size(&step.predicates).unwrap_or(50).max(1) as usize;
	let chunk_count = line_count.div_ceil(chunk_size);

	let mut selected: Vec<usize> = (1..=chunk_count).collect();

	for pred in &step.predicates {
		selected.retain(|cn| chunk_predicate(pred, *cn, chunk_count));
	}

	selected
		.into_iter()
		.map(|cn| {
			let start_line = (cn - 1) * chunk_size + 1;
			let end_line = (cn * chunk_size).min(line_count);
			let start_range = line_index
				.line_range(start_line, content.len())
				.unwrap_or(0..0);
			let end_range = line_index
				.line_range(end_line, content.len())
				.unwrap_or(0..0);
			let range = start_range.start..end_range.end;
			let chunk_text = text[range.clone()].to_string();
			NodeRef {
				locator: format!("<chunk {}>", cn),
				range,
				kind: "§chunk".to_string(),
				content: Some(Content::Text { value: chunk_text }),
				metadata: HashMap::new(),
				diagnostics: Vec::new(),
			}
		})
		.collect()
}

fn parse_chunk_size(predicates: &[Predicate]) -> Option<u64> {
	for pred in predicates {
		match pred {
			Predicate::Attribute { name, value } if name == "n" => {
				return value.parse().ok();
			},
			Predicate::Compare { name, op, value } if name == "n" && matches!(op, CompareOp::Eq) => {
				return value.parse().ok();
			},
			_ => {},
		}
	}
	None
}

fn chunk_predicate(pred: &Predicate, chunk_num: usize, chunk_count: usize) -> bool {
	match pred {
		Predicate::Range { start, end } => {
			let count = chunk_count as isize;
			let s = start
				.map(|v| if v < 0 { count + v + 1 } else { v.max(1) })
				.unwrap_or(1);
			let e = end
				.map(|v| if v < 0 { count + v + 1 } else { v })
				.unwrap_or(count);
			let idx = chunk_num as isize;
			idx >= s && idx <= e
		},
		Predicate::Ordinal(n) => {
			let count = chunk_count as isize;
			let target = if *n < 0 { count + *n + 1 } else { *n };
			(chunk_num as isize) == target
		},
		Predicate::Flag(name) => match name.as_str() {
			"last" => chunk_num == chunk_count,
			_ => false,
		},
		_ => true,
	}
}

// ── helpers ─────────────────────────────────────────────────────

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

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ast::{Axis, Head};

	fn step(predicates: Vec<Predicate>) -> Step {
		Step { axis: Some(Axis::Structural), head: Head::NodeKind("line".to_string()), predicates }
	}

	#[test]
	fn line_axis_all_lines() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![]));
		assert_eq!(nodes.len(), 3);
		assert_eq!(nodes[0].locator, "<line 1>");
		assert_eq!(nodes[1].locator, "<line 2>");
	}

	#[test]
	fn line_axis_range_slice() {
		let content = b"a\nb\nc\nd\n";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(2), end: Some(3) }]));
		assert_eq!(nodes.len(), 2);
		assert_eq!(nodes[0].locator, "<line 2>"); // 1-indexed: 2..=3 => lines 2 & 3
		assert_eq!(nodes[1].locator, "<line 3>");
	}

	#[test]
	fn line_axis_ordinal() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![Predicate::Ordinal(2)]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<line 2>"); // ordinal 2 => line 2
	}

	#[test]
	fn line_axis_last_ordinal() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![Predicate::Ordinal(-1)]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<line 3>");
	}

	#[test]
	fn line_axis_text_match() {
		let content = b"foo\nbar\nbaz\n";
		let nodes = line_steps(content, &step(vec![Predicate::TextMatch(r"ba.".to_string())]));
		assert_eq!(nodes.len(), 2);
		assert_eq!(nodes[0].locator, "<line 2>");
		assert_eq!(nodes[1].locator, "<line 3>");
	}

	#[test]
	fn line_axis_literal_match() {
		let content = b"foo\nbar\nbaz\n";
		let nodes = line_steps(content, &step(vec![Predicate::LiteralMatch("ba".to_string())]));
		assert_eq!(nodes.len(), 2);
	}

	#[test]
	fn line_axis_compare_len() {
		let content = b"a\nabcd\nabc\n";
		let nodes = line_steps(
			content,
			&step(vec![Predicate::Compare {
				name:  "len".to_string(),
				op:    CompareOp::Gt,
				value: "2".to_string(),
			}]),
		);
		assert_eq!(nodes.len(), 2); // "a\n" len=2, "abcd\n" len=5, "abc\n" len=4
		assert_eq!(nodes[0].locator, "<line 2>");
		assert_eq!(nodes[1].locator, "<line 3>");
	}

	#[test]
	fn line_axis_flag_empty() {
		let content = b"foo\n\nbar\n   \n";
		let nodes = line_steps(content, &step(vec![Predicate::Flag("empty".to_string())]));
		assert_eq!(nodes.len(), 2);
	}

	#[test]
	fn line_axis_flag_last() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![Predicate::Flag("last".to_string())]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<line 3>");
	}

	#[test]
	fn para_axis_basic() {
		let content = b"p1\n\np2\n\np3\n";
		let s = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("para".to_string()),
			predicates: vec![],
		};
		let nodes = para_steps(content, &s);
		assert_eq!(nodes.len(), 3);
		assert_eq!(nodes[0].locator, "<para 1>");
		assert_eq!(nodes[1].locator, "<para 2>");
	}

	#[test]
	fn chunk_axis_default_size() {
		let content = b"1\n2\n3\n4\n5\n";
		let s = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("chunk".to_string()),
			predicates: vec![],
		};
		let nodes = chunk_steps(content, &s);
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<chunk 1>");
	}

	#[test]
	fn chunk_axis_custom_size() {
		let content = b"1\n2\n3\n4\n5\n";
		let s = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("chunk".to_string()),
			predicates: vec![Predicate::Attribute { name: "n".to_string(), value: "2".to_string() }],
		};
		let nodes = chunk_steps(content, &s);
		assert_eq!(nodes.len(), 3); // 2+2+1 lines => 3 chunks
		assert_eq!(nodes[0].locator, "<chunk 1>");
		assert_eq!(nodes[1].locator, "<chunk 2>");
		assert_eq!(nodes[2].locator, "<chunk 3>");
	}

	#[test]
	fn chunk_axis_compare_size() {
		let content = b"1\n2\n3\n4\n5\n";
		let s = Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("chunk".to_string()),
			predicates: vec![
				Predicate::Attribute { name: "n".to_string(), value: "2".to_string() },
				Predicate::Range { start: Some(1), end: Some(1) },
			],
		};
		let nodes = chunk_steps(content, &s);
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<chunk 1>");
	}

	#[test]
	fn line_axis_negative_range_tail() {
		let content = b"1\n2\n3\n4\n5\n";
		let nodes = line_steps(content, &step(vec![Predicate::Range { start: Some(-2), end: None }]));
		assert_eq!(nodes.len(), 2);
		assert_eq!(nodes[0].locator, "<line 4>");
		assert_eq!(nodes[1].locator, "<line 5>");
	}
}
