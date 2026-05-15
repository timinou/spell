//! Axis-step resolution for the text dialect.
//!
//! `§line`, `§para`, and `§chunk` are the supported node-kind heads.

use std::{borrow::Cow, collections::HashMap, ops::Range};

use regex::Regex;

use super::{anchor::line_anchor_id, line_index::LineIndex, para_index::ParaIndex};
use crate::{
	ast::{CompareOp, Predicate, Step},
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

// ── §line ────────────────────────────────────────────────────────

/// Decode `content[range]` as UTF-8 with `U+FFFD` replacement for invalid
/// bytes. Slicing the raw `&[u8]` first keeps caller-facing byte ranges in
/// original-content coordinates; decoding per slice avoids the offset drift
/// that a single pre-decoded `String::from_utf8_lossy(content)` introduces
/// when invalid bytes expand to a 3-byte `�` and shift downstream indices.
fn slice_lossy(content: &[u8], range: Range<usize>) -> Cow<'_, str> {
	let end = range.end.min(content.len());
	let start = range.start.min(end);
	String::from_utf8_lossy(&content[start..end])
}

/// Apply a `§line` step to `content`.
pub fn line_steps(content: &[u8], step: &Step) -> Vec<NodeRef> {
	let line_index = LineIndex::build(content);
	// Slice mode: exactly one Range predicate → emit ONE node with joined text.
	if let Some((start, end)) = slice_range_only(&step.predicates) {
		return vec![build_line_slice(content, &line_index, start, end)];
	}

	let mut selected: Vec<usize> = (1..=line_index.line_count()).collect();

	for pred in &step.predicates {
		selected.retain(|ln| line_predicate(pred, *ln, content, &line_index));
	}

	selected
		.into_iter()
		.map(|ln| {
			let range = line_index.line_range(ln, content.len()).unwrap_or(0..0);
			let line_text = slice_lossy(content, range.clone()).into_owned();
			let anchor = line_anchor_id(line_text.trim_end_matches(['\n', '\r']));
			let mut metadata = HashMap::new();
			metadata.insert("anchorId".to_string(), serde_json::Value::String(anchor.clone()));
			metadata.insert("line".to_string(), serde_json::Value::Number(ln.into()));
			NodeRef {
				locator: format!("<line {ln}#{anchor}>"),
				range,
				kind: "§line".to_string(),
				content: Some(Content::Text { value: line_text }),
				metadata,
				diagnostics: Vec::new(),
			}
		})
		.collect()
}

/// Returns Some((start, end)) when `predicates` is exactly one `Range`
/// predicate. `start`/`end` are the raw isize bounds (negatives allowed; `None`
/// = open).
fn slice_range_only(predicates: &[Predicate]) -> Option<(Option<isize>, Option<isize>)> {
	if predicates.len() != 1 {
		return None;
	}
	match &predicates[0] {
		Predicate::Range { start, end } => Some((*start, *end)),
		_ => None,
	}
}

/// Build a single sliced `§line` node from `start..=end` (1-indexed,
/// inclusive). Negative bounds resolve from EOF; out-of-range bounds clamp with
/// a warning.
fn build_line_slice(
	content: &[u8],
	line_index: &LineIndex,
	start_raw: Option<isize>,
	end_raw: Option<isize>,
) -> NodeRef {
	let count = line_index.line_count() as isize;
	let resolve = |raw: isize| -> isize { if raw < 0 { count + raw + 1 } else { raw } };
	let (resolved_start, resolved_end) = match (start_raw, end_raw) {
		(None, None) => (1, count),
		(Some(s), None) => (resolve(s), count),
		(None, Some(e)) => (1, resolve(e)),
		(Some(s), Some(e)) => (resolve(s), resolve(e)),
	};

	let mut diagnostics: Vec<Diagnostic> = Vec::new();

	// Inverted bounds (start > end) ⇒ explicit diagnostic, empty body.
	if resolved_start > resolved_end {
		diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::RangeBoundsInverted,
			message: format!(
				"§line range bounds inverted: start={resolved_start} > end={resolved_end}"
			),
			span:    None,
		});
		return slice_node(0..0, String::new(), resolved_start, resolved_end, diagnostics);
	}

	// 0-line file or empty intersection ⇒ empty body, no diagnostic.
	if count == 0 {
		return slice_node(0..0, String::new(), resolved_start, resolved_end, diagnostics);
	}

	// Clamp to file extent (1..=count). Emit warning if either bound was outside.
	let clamped_start = resolved_start.max(1).min(count);
	let clamped_end = resolved_end.max(1).min(count);
	let clamped = resolved_start != clamped_start || resolved_end != clamped_end;
	if clamped {
		diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::RangeClamped,
			message: format!(
				"§line range {resolved_start}..{resolved_end} clamped to \
				 {clamped_start}..{clamped_end} (file has {count} line(s))"
			),
			span:    None,
		});
	}

	let first = clamped_start as usize;
	let last = clamped_end as usize;
	let start_range = line_index.line_range(first, content.len()).unwrap_or(0..0);
	let end_range = line_index.line_range(last, content.len()).unwrap_or(0..0);
	let byte_range = start_range.start..end_range.end;
	let body = slice_lossy(content, byte_range.clone()).into_owned();
	slice_node(byte_range, body, clamped_start, clamped_end, diagnostics)
}

fn slice_node(
	range: std::ops::Range<usize>,
	body: String,
	start: isize,
	end: isize,
	diagnostics: Vec<Diagnostic>,
) -> NodeRef {
	let mut metadata = HashMap::new();
	metadata.insert("shape".to_string(), serde_json::Value::String("slice".to_string()));
	metadata.insert("lineStart".to_string(), serde_json::Value::Number(start.into()));
	metadata.insert("lineEnd".to_string(), serde_json::Value::Number(end.into()));
	NodeRef {
		locator: format!("<line {start}..{end}>"),
		range,
		kind: "§line".to_string(),
		content: Some(Content::Text { value: body }),
		metadata,
		diagnostics,
	}
}

fn line_predicate(
	pred: &Predicate,
	line_num: usize,
	content: &[u8],
	line_index: &LineIndex,
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
			let line_text = slice_lossy(content, range);
			Regex::new(pattern)
				.map(|re| re.is_match(&line_text))
				.unwrap_or(false)
		},
		Predicate::LiteralMatch(lit) => {
			let range = line_index
				.line_range(line_num, content.len())
				.unwrap_or(0..0);
			let line_text = slice_lossy(content, range);
			line_text.contains(lit.as_str())
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
				let line_text = slice_lossy(content, range);
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
	let mut selected: Vec<usize> = (1..=para_index.para_count()).collect();

	for pred in &step.predicates {
		selected.retain(|pn| para_predicate(pred, *pn, content, &para_index));
	}

	selected
		.into_iter()
		.map(|pn| {
			let range = para_index.para_range(pn, content.len()).unwrap_or(0..0);
			let para_text = slice_lossy(content, range.clone()).into_owned();
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
			let para_text = slice_lossy(content, range);
			Regex::new(pattern)
				.map(|re| re.is_match(&para_text))
				.unwrap_or(false)
		},
		Predicate::LiteralMatch(lit) => {
			let range = para_index
				.para_range(para_num, content.len())
				.unwrap_or(0..0);
			let para_text = slice_lossy(content, range);
			para_text.contains(lit.as_str())
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
			let chunk_text = slice_lossy(content, range.clone()).into_owned();
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
		assert!(nodes[0].locator.starts_with("<line 1#"), "{}", nodes[0].locator);
		assert!(nodes[1].locator.starts_with("<line 2#"), "{}", nodes[1].locator);
	}

	#[test]
	fn line_axis_range_slice() {
		let content = b"a\nb\nc\nd\n";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(2), end: Some(3) }]));
		assert_eq!(nodes.len(), 1);
		let n = &nodes[0];
		assert_eq!(n.kind, "§line");
		assert_eq!(n.locator, "<line 2..3>");
		let body = match n.content.as_ref().unwrap() {
			Content::Text { value } => value.as_str(),
			_ => panic!("slice node must be Text"),
		};
		assert_eq!(body, "b\nc\n");
		assert!(n.diagnostics.is_empty(), "in-bounds slice has no diagnostics");
		assert_eq!(n.metadata.get("shape").and_then(|v| v.as_str()), Some("slice"));
	}

	#[test]
	fn line_axis_ordinal() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![Predicate::Ordinal(2)]));
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].locator.starts_with("<line 2#"), "{}", nodes[0].locator); // ordinal 2 => line 2
	}

	#[test]
	fn line_axis_last_ordinal() {
		let content = b"a\nb\nc\n";
		let nodes = line_steps(content, &step(vec![Predicate::Ordinal(-1)]));
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].locator.starts_with("<line 3#"), "{}", nodes[0].locator);
	}

	#[test]
	fn line_axis_text_match() {
		let content = b"foo\nbar\nbaz\n";
		let nodes = line_steps(content, &step(vec![Predicate::TextMatch(r"ba.".to_string())]));
		assert_eq!(nodes.len(), 2);
		assert!(nodes[0].locator.starts_with("<line 2#"), "{}", nodes[0].locator);
		assert!(nodes[1].locator.starts_with("<line 3#"), "{}", nodes[1].locator);
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
		assert!(nodes[0].locator.starts_with("<line 2#"), "{}", nodes[0].locator);
		assert!(nodes[1].locator.starts_with("<line 3#"), "{}", nodes[1].locator);
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
		assert!(nodes[0].locator.starts_with("<line 3#"), "{}", nodes[0].locator);
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
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "<line 4..5>");
		let body = match nodes[0].content.as_ref().unwrap() {
			Content::Text { value } => value.as_str(),
			_ => panic!("slice node must be Text"),
		};
		assert_eq!(body, "4\n5\n");
	}

	// ── FEAT-716 slice-shape coverage (W2a–W2g) ────────────────────────────

	fn slice_body(node: &NodeRef) -> &str {
		match node.content.as_ref().unwrap() {
			Content::Text { value } => value.as_str(),
			_ => panic!("slice node must be Text"),
		}
	}

	#[test]
	fn w2a_range_a_to_b_single_body() {
		let content = b"l1\nl2\nl3\nl4\n";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(2), end: Some(3) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l2\nl3\n");
		assert_eq!(nodes[0].locator, "<line 2..3>");
		assert!(nodes[0].diagnostics.is_empty());
	}

	#[test]
	fn w2b_head_open_start() {
		let content = b"l1\nl2\nl3\nl4\nl5\n";
		let nodes = line_steps(content, &step(vec![Predicate::Range { start: None, end: Some(3) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l1\nl2\nl3\n");
		assert!(nodes[0].diagnostics.is_empty());
	}

	#[test]
	fn w2c_tail_open_end() {
		let content = b"l1\nl2\nl3\nl4\n";
		let nodes = line_steps(content, &step(vec![Predicate::Range { start: Some(3), end: None }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l3\nl4\n");
		assert_eq!(nodes[0].locator, "<line 3..4>");
	}

	#[test]
	fn w2d_negative_anchor_tail_n() {
		let content = b"l1\nl2\nl3\nl4\n";
		let nodes = line_steps(content, &step(vec![Predicate::Range { start: Some(-2), end: None }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l3\nl4\n");
	}

	#[test]
	fn w2e_single_ordinal_keeps_anchor() {
		let content = b"l1\nl2\nl3\nl4\n";
		let nodes = line_steps(content, &step(vec![Predicate::Ordinal(2)]));
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].locator.starts_with("<line 2#"), "{}", nodes[0].locator);
		// keeps per-line anchor metadata, not slice metadata
		assert!(nodes[0].metadata.contains_key("anchorId"));
		assert!(!nodes[0].metadata.contains_key("shape"));
	}

	#[test]
	fn w2f_text_match_keeps_per_line() {
		let content = b"foo\nbar\nbaz\n";
		let nodes = line_steps(content, &step(vec![Predicate::TextMatch(r"ba.".to_string())]));
		assert_eq!(nodes.len(), 2);
		assert!(nodes[0].locator.starts_with("<line 2#"));
		assert!(nodes[1].locator.starts_with("<line 3#"));
	}

	#[test]
	fn w2g_eof_clamp_with_warning() {
		let content = b"l1\nl2\nl3\n";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(2), end: Some(99) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l2\nl3\n");
		assert_eq!(nodes[0].diagnostics.len(), 1);
		assert!(matches!(nodes[0].diagnostics[0].variant, DiagnosticVariant::RangeClamped));
	}

	#[test]
	fn slice_inverted_bounds_emits_diagnostic() {
		let content = b"l1\nl2\nl3\n";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(10), end: Some(5) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "");
		assert_eq!(nodes[0].diagnostics.len(), 1);
		assert!(matches!(nodes[0].diagnostics[0].variant, DiagnosticVariant::RangeBoundsInverted));
	}

	#[test]
	fn slice_zero_line_file_empty_no_diag() {
		let content = b"";
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(1), end: Some(5) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "");
		assert!(nodes[0].diagnostics.is_empty());
	}

	#[test]
	fn slice_no_trailing_newline_final_line_counted() {
		let content = b"l1\nl2\nl3";
		let nodes = line_steps(content, &step(vec![Predicate::Range { start: Some(2), end: None }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]), "l2\nl3");
	}

	#[test]
	fn slice_byte_overhead_bounded() {
		// Output bytes for a 50-line slice ≤ source-bytes + small header.
		let mut src = String::new();
		for i in 1..=50 {
			src.push_str(&format!("line {i}\n"));
		}
		let content = src.as_bytes();
		let nodes =
			line_steps(content, &step(vec![Predicate::Range { start: Some(1), end: Some(50) }]));
		assert_eq!(nodes.len(), 1);
		assert_eq!(slice_body(&nodes[0]).len(), src.len());
	}

	// ── invalid-UTF-8 regression ───────────────────────────────────
	//
	// `line_predicate` / chunk / para used to share a single
	// `String::from_utf8_lossy(content)` buffer while indexing with
	// raw-byte `LineIndex` offsets. Invalid bytes expand to a 3-byte
	// `U+FFFD`, shifting downstream offsets and causing
	// `&text[range]` to land mid-`�` → "not a char boundary" panic
	// (surfaced as an abort across the napi async-work FFI boundary).

	#[test]
	fn line_predicate_literal_invalid_utf8_no_panic() {
		// `\xC3\x28` is an invalid UTF-8 sequence.
		let content: &[u8] = b"hello \xC3\x28 world\nsecond line\n";
		let nodes = line_steps(
			content,
			&step(vec![Predicate::LiteralMatch("world".to_string())]),
		);
		assert_eq!(nodes.len(), 1);
		assert!(matches!(
			&nodes[0].content,
			Some(Content::Text { value }) if value.contains("world")
		));
	}

	#[test]
	fn line_slice_invalid_utf8_no_panic() {
		// Multi-byte invalid sequences (binary-blob shape) plus a final
		// newline so LineIndex produces a valid range whose `end` lands
		// where a single shared `from_utf8_lossy` would split a `ÿfd`.
		let mut content: Vec<u8> = Vec::new();
		content.extend_from_slice(b"prefix\n");
		content.extend_from_slice(&[0x84, 0xFE, 0xC0, 0x80, 0xFF]);
		content.extend_from_slice(b"\nsuffix\n");
		let nodes = line_steps(
			&content,
			&step(vec![Predicate::Range { start: Some(1), end: Some(3) }]),
		);
		assert_eq!(nodes.len(), 1);
		// Round-trips through lossy decoding; must not panic.
		assert!(slice_body(&nodes[0]).contains("prefix"));
		assert!(slice_body(&nodes[0]).contains("suffix"));
	}

	#[test]
	fn chunk_steps_invalid_utf8_no_panic() {
		let mut content: Vec<u8> = Vec::new();
		for _ in 0..3 {
			content.extend_from_slice(b"ok line\n");
			content.extend_from_slice(&[0xC3, 0x28, b'\n']);
		}
		let nodes = chunk_steps(&content, &step(vec![]));
		assert!(!nodes.is_empty());
	}
}
