//! Generic tree-sitter -> `form_tree` projector + unparser (PLAN-020 W3).
//!
//! `form_tree` is the canonical walkable node shape the whole q/* algebra runs
//! on, already shared by Lisp history (`SpellAgent.Hist.Lens.form_tree/1`) and
//! the brush shell projector (`brush_nif::project`). This module projects a
//! tree-sitter parse of SOURCE CODE into the SAME shape, so one structural
//! engine walks source, shell, and history alike (the PLAN-020 thesis).
//!
//! Node shape (string-keyed JSON, the form_tree contract):
//!
//! ```text
//! {"node": <kind>, "name"?: <field-name>, "value"?: <leaf text>,
//!  "text"?: <verbatim source slice>, "children"?: [<node>]}
//! ```
//!
//! - `node`     = the tree-sitter node KIND (`call`, `identifier`,
//!   `binary_operator`, ...).
//! - `name`     = the FIELD name this node fills in its parent, when
//!   tree-sitter names it (e.g. a function's `name:` field). This is how a q/*
//!   pattern addresses a child structurally, mirroring how the Lisp projector
//!   puts a def's name in `"name"`.
//! - `value`    = a LEAF's exact source text (identifiers, literals,
//!   operators).
//! - `text`     = the verbatim source slice for the WHOLE node. Carried so an
//!   UNTOUCHED subtree round-trips byte-exactly through `unparse` (the
//!   formatter-canonicalizes contract only kicks in for EDITED subtrees, where
//!   `text` is dropped and children are rejoined).
//! - `children` = projected NAMED children (anonymous tokens/punctuation are
//!   not structural and are reconstructed by `unparse`, not projected).
//!
//! Drift-resilience (mirrors brush): a tree-sitter ERROR/MISSING node, or any
//! node past `MAX_DEPTH`, projects to a `{"node":"raw","value":<source>}` leaf
//! rather than failing. So `parse` NEVER errors on valid-but-unmodelled source;
//! the exotic tail degrades to a `raw` leaf that `unparse` round-trips
//! verbatim.

use serde_json::{Value, json};
use tree_sitter::{Node, Parser, Tree};

/// Depth beyond which a node degrades to a `raw` leaf. Bounds both stack usage
/// and pathological deeply-nested input (the brush projector caps at 256 too).
const MAX_DEPTH: usize = 256;

/// Project `src` parsed under `language` into a `form_tree` JSON value.
///
/// Returns `Err` only on a genuine tree-sitter failure (no tree produced).
/// A parse that yields ERROR nodes still SUCCEEDS — the errors become `raw`
/// leaves, so the common 90% structures cleanly and the exotic tail is
/// preserved, never lost.
pub fn parse_to_form_tree(language: &tree_sitter::Language, src: &str) -> Result<Value, String> {
	let mut parser = Parser::new();
	parser
		.set_language(language)
		.map_err(|e| format!("set_language failed: {e}"))?;
	let tree: Tree = parser
		.parse(src, None)
		.ok_or_else(|| "tree-sitter parse returned no tree".to_string())?;
	let bytes = src.as_bytes();
	Ok(project_node(tree.root_node(), bytes, 0))
}

/// Project one tree-sitter node into a form_tree value.
fn project_node(node: Node<'_>, src: &[u8], depth: usize) -> Value {
	// Drift-resilient fallback. A MISSING (zero-width inserted) node and an
	// over-deep node become `raw` leaves carrying their exact source span.
	//
	// An ERROR node is NOT collapsed wholesale: tree-sitter's error recovery
	// often leaves a valid named subtree under an ERROR wrapper, and discarding
	// it would make the whole span structurally opaque (it would degrade a
	// PLAN-018 reduction / a q/* edit to the heuristic tier for no reason). So an
	// ERROR node with children is projected like any internal node but tagged
	// `"error": true`; only a CHILDLESS error (truly unwalkable) falls to `raw`.
	if depth >= MAX_DEPTH || node.is_missing() || (node.is_error() && node.child_count() == 0) {
		return raw_leaf(node, src);
	}

	let kind = node.kind();
	let text = node_text(node, src);

	// A TRUE leaf has no children at all (named OR anonymous) — an identifier,
	// literal, or operator token. Carry its exact text as `value` (and `text` for
	// byte-exact round-trip).
	if node.child_count() == 0 {
		let mut map = serde_json::Map::new();
		map.insert("node".into(), json!(kind));
		map.insert("value".into(), json!(text));
		map.insert("text".into(), json!(text));
		return Value::Object(map);
	}

	// An internal node: project ALL children in source order. NAMED children are
	// recursively projected (and tagged with the FIELD name tree-sitter assigns,
	// so a pattern can address a child by role). ANONYMOUS tokens (operators,
	// punctuation, keywords — `+`, `(`, `,`, `do`, `end`) are projected as
	// `{"node":"token","value":<text>}` LEAVES so that `code/unparse` can rejoin an
	// EDITED subtree without losing operators/delimiters. The q/* algebra matches
	// on `node`/`name`, so token leaves are simply skipped by structural patterns
	// — they cost nothing to matching but make rejoin-on-edit lossless.
	let mut child_cursor = node.walk();
	let mut children: Vec<Value> = Vec::new();
	if child_cursor.goto_first_child() {
		loop {
			let child = child_cursor.node();
			if child.is_named() {
				let field = child_cursor.field_name();
				let mut projected = project_node(child, src, depth + 1);
				// Tag the child with the tree-sitter FIELD ROLE under `field` — NOT
				// `name`. The `name` key is reserved across all three form_tree
				// producers for a SEMANTIC name (a def's symbol in Lens, a command
				// head in brush); a field role (`left`/`right`/`argument`) is a
				// different concept, so it gets its own key. This keeps a
				// surface-generic q/* pattern matching `name` consistent across
				// source, shell, and history.
				if let (Some(field), Value::Object(map)) = (field, &mut projected) {
					map.insert("field".into(), json!(field));
				}
				children.push(projected);
			} else {
				// anonymous token — a punctuation/operator leaf
				children.push(json!({ "node": "token", "value": node_text(child, src) }));
			}
			if !child_cursor.goto_next_sibling() {
				break;
			}
		}
	}

	let mut map = serde_json::Map::new();
	map.insert("node".into(), json!(kind));
	map.insert("text".into(), json!(text));
	map.insert("children".into(), Value::Array(children));
	// Mark a recovered ERROR subtree so a consumer can choose to treat it as
	// algebra-opaque (PLAN-018) while still walking its recovered children.
	if node.is_error() {
		map.insert("error".into(), json!(true));
	}
	Value::Object(map)
}

/// A `raw` leaf carrying a node's verbatim source span.
fn raw_leaf(node: Node<'_>, src: &[u8]) -> Value {
	json!({ "node": "raw", "value": node_text(node, src) })
}

/// The exact UTF-8 source slice a node spans (lossy-safe on invalid UTF-8).
fn node_text(node: Node<'_>, src: &[u8]) -> String {
	let range = node.byte_range();
	String::from_utf8_lossy(&src[range.start..range.end]).into_owned()
}

/// Render a `form_tree` value back to source.
///
/// Round-trip contract (mirrors brush's re-parse equality, NOT byte equality):
/// - an UNTOUCHED node still carries its `text` -> emit it VERBATIM
///   (byte-exact).
/// - an EDITED node (children changed, `text` dropped by the editor) -> rejoin
///   its children with CONTEXT-AWARE spacing (see `join_pieces`): tight
///   punctuation (`(` `)` `[` `]` `{` `}` `,` `.` etc.) binds to its neighbor
///   so `foo(x)` does not become `foo ( x )` (which re-parses differently). A
///   formatter canonicalizes the rest.
/// - a `raw` leaf -> its `value` verbatim.
/// - a leaf with `value` but no `text` (hand-built) -> the `value`.
pub fn unparse_form_tree(node: &Value) -> String {
	match node {
		Value::Object(map) => {
			// A node that still has its verbatim text is untouched -> emit exactly.
			if let Some(Value::String(text)) = map.get("text") {
				return text.clone();
			}
			// A `raw` leaf or a hand-built leaf -> its value.
			if let Some(Value::String(value)) = map.get("value") {
				return value.clone();
			}
			// An edited internal node -> rejoin projected children with grammar-
			// aware spacing so delimiters stay adjacent to their operand.
			if let Some(Value::Array(children)) = map.get("children") {
				let pieces: Vec<String> = children.iter().map(unparse_form_tree).collect();
				return join_pieces(&pieces);
			}
			String::new()
		},
		Value::String(s) => s.clone(),
		_ => String::new(),
	}
}

/// Join rendered child pieces with re-parse-safe spacing. A space is inserted
/// between two pieces UNLESS the boundary is "tight": an opening bracket binds
/// to what follows, a closing bracket / separator binds to what precedes, and a
/// dot binds both sides (`Enum.map`, `a.b`). This keeps `foo(x)`, `a.b`,
/// `[1,2]`, and `%{a: 1}` adjacent after an edit instead of `foo ( x )` etc.
fn join_pieces(pieces: &[String]) -> String {
	let mut out = String::new();
	let mut prev: Option<&str> = None;
	for piece in pieces {
		if piece.is_empty() {
			continue;
		}
		if let Some(prev) = prev {
			if needs_space(prev, piece) {
				out.push(' ');
			}
		}
		out.push_str(piece);
		prev = Some(piece);
	}
	out
}

/// Whether a space belongs between rendered pieces `left` and `right`.
fn needs_space(left: &str, right: &str) -> bool {
	let lc = left.chars().last();
	let rc = right.chars().next();
	match (lc, rc) {
		(_, None) | (None, _) => false,
		(Some(l), Some(r)) => {
			// A dot binds both sides: `Enum.map`, `a.b`.
			if l == '.' || r == '.' {
				return false;
			}
			// An opening bracket binds to what follows: `foo(`, `[1`, `{a`.
			if matches!(l, '(' | '[' | '{') {
				return false;
			}
			// A closing bracket / separator binds to what precedes: `x)`, `1]`,
			// `a,` `b;` `k:`.
			if matches!(r, ')' | ']' | '}' | ',' | ';' | ':') {
				return false;
			}
			// A call/access bracket binds TIGHT to the operand it follows:
			// `foo(`, `a[`, `x)(` — no space when an identifier/closing-bracket is
			// immediately followed by `(` or `[`. (A space there would re-parse
			// differently in Elixir: `foo (y)` is a space-call, not `foo(y)`.)
			if matches!(r, '(' | '[') && (l.is_alphanumeric() || l == '_' || matches!(l, ')' | ']')) {
				return false;
			}
			true
		},
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn untouched_node_unparses_to_its_verbatim_text() {
		// A node that still carries `text` round-trips byte-exactly, ignoring its
		// children (the untouched fast path).
		let node = json!({
			"node": "binary_operator",
			"text": "x  +  1",
			"children": [
				{"node": "identifier", "value": "x", "text": "x"},
				{"node": "token", "value": "+"},
				{"node": "integer", "value": "1", "text": "1"}
			]
		});
		assert_eq!(unparse_form_tree(&node), "x  +  1");
	}

	#[test]
	fn edited_node_rejoins_children_including_anonymous_tokens() {
		// With `text` dropped (the editor's signal that the node changed), rejoin
		// must include the anonymous `+` token, not lose it.
		let node = json!({
			"node": "binary_operator",
			"children": [
				{"node": "identifier", "value": "y"},
				{"node": "token", "value": "+"},
				{"node": "integer", "value": "1"}
			]
		});
		assert_eq!(unparse_form_tree(&node), "y + 1");
	}

	#[test]
	fn raw_leaf_unparses_verbatim() {
		let node = json!({"node": "raw", "value": "@@@ !!!"});
		assert_eq!(unparse_form_tree(&node), "@@@ !!!");
	}

	#[test]
	fn leaf_value_is_used_when_text_absent() {
		let node = json!({"node": "identifier", "value": "z"});
		assert_eq!(unparse_form_tree(&node), "z");
	}
}
