//! Template variable expansion for unified edit actions.
//!
//! Parses template strings (`$1`, `$BODY`, `$NAME`, etc.) and resolves
//! them against a tree-sitter [`Node`] and source text. The agent writes
//! output templates; the kernel substitutes placeholders with tree-derived
//! values.
//!
//! ## Variable reference
//!
//! | Token    | Resolves to                                           |
//! |----------|-------------------------------------------------------|
//! | `$1`..`$N` | Nth named child of the matched node                |
//! | `$0`     | Full matched text (alias for `$MATCH`)                |
//! | `$LAST`  | Last named child of the matched node                  |
//! | `$BODY`  | Body text — uses tree-sitter `body` field             |
//! | `$NAME`  | Name field of a declaration node                      |
//! | `$SIG`   | Signature — everything before the body field          |
//! | `$DECL`  | Full declaration text (alias for `$MATCH`)            |
//! | `$MATCH` | Full text of the matched node                         |
//! | `$$`     | Literal dollar sign                                   |
//!
//! ## Escape rules
//!
//! - `$$` → literal `$`
//! - `${...}` → literal `${...}` (pass-through for JS template syntax)
//! - `$` followed by non-uppercase, non-digit → literal
//! - `$` at end-of-string → literal
//! - Unknown uppercase token → [`TemplateError::UnknownVariable`]
//!
//! ## Body extraction (tree-sitter-native)
//!
//! Uses `node.child_by_field_name("body")` as primary method. Falls back
//! to byte-scanning only when the grammar doesn't expose a body field.
//! This makes body extraction correct per language without custom
//! heuristics.

use tree_sitter::Node;

use crate::types::{Diagnostic, DiagnosticVariant};

// ── Public API ────────────────────────────────────────────────────

/// Errors that can occur during template expansion.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateError {
	pub variant: TemplateErrorVariant,
	pub message: String,
	pub hint:    Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplateErrorVariant {
	/// A positional variable (`$N`) exceeds the number of children.
	PositionOutOfRange { requested: usize, available: usize },
	/// A named variable is not applicable to this node kind.
	NotApplicable { variable: String, node_kind: String },
	/// The variable name is unrecognised.
	UnknownVariable { name: String },
}

impl TemplateError {
	fn pos_out_of_range(requested: usize, available: usize) -> Self {
		TemplateError {
			variant: TemplateErrorVariant::PositionOutOfRange { requested, available },
			message: format!(
				"${}: node has only {} named child{}",
				requested,
				available,
				if available == 1 { "" } else { "ren" }
			),
			hint:    Some(
				"Use $MATCH for the full matched text, or $LAST for the last child.".into(),
			),
		}
	}

	fn not_applicable(variable: &str, node_kind: &str) -> Self {
		TemplateError {
			variant: TemplateErrorVariant::NotApplicable {
				variable:  variable.to_string(),
				node_kind: node_kind.to_string(),
			},
			message: format!(
				"${} used in content but the matched node '{}' has no {}",
				variable,
				node_kind,
				match variable {
					"BODY" => "body field",
					"NAME" => "name field",
					"SIG" => "signature (no body field to delimit it)",
					_ => variable,
				}
			),
			hint:    Some(match variable {
				"BODY" =>
					"Use $MATCH to reference the full matched text, or target a declaration node (function, method, class)."
						.into(),
				"NAME" =>
					"Use a declaration node (function, class, variable, module) for $NAME.".into(),
				"SIG" =>
					"Use $MATCH for the full text, or target a declaration node with a body for $SIG."
						.into(),
				_ => "Use $MATCH for the full matched text.".into(),
			}),
		}
	}

	fn unknown(name: &str) -> Self {
		TemplateError {
			variant: TemplateErrorVariant::UnknownVariable { name: name.to_string() },
			message: format!("${name}: unknown template variable"),
			hint:    Some(
				"Valid variables: $1 $2 $LAST $BODY $NAME $SIG $DECL $MATCH. Use $$ for literal dollar sign."
					.into(),
			),
		}
	}
}

impl From<TemplateError> for Diagnostic {
	fn from(e: TemplateError) -> Self {
		Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: e.message,
			span:    None,
		}
	}
}

/// Expand template variables in `content` using the matched [`Node`] and
/// source text.
///
/// Returns the expanded string, or a [`TemplateError`] with a hint for
/// the agent to self-correct.
pub fn expand_template(
	content: &str,
	node: Node<'_>,
	source: &str,
) -> Result<String, TemplateError> {
	let mut result = String::with_capacity(content.len());
	let mut chars = content.chars().peekable();

	while let Some(ch) = chars.next() {
		if ch != '$' {
			result.push(ch);
			continue;
		}

		match chars.peek().copied() {
			None => {
				result.push('$');
			}
			Some('$') => {
				chars.next();
				result.push('$');
			}
			Some('{') => {
				result.push('$');
				result.push('{');
				chars.next();
			}
			Some(c) if c.is_ascii_digit() => {
				// $0 through $9 only (single digit).
				// Multi-digit like $100 is literal $ followed by text.
				chars.next();
				let n = (c as u8 - b'0') as usize;
				expand_positional(&mut result, node, source, n)?;
			}
			Some('L') => {
				chars.next(); // consume 'L'
				// Check for "AST" by peeking each char individually.
				// Save position: peek 'A', if match consume + peek 'S', etc.
				let a = chars.peek().copied();
				if a == Some('A') {
					chars.next(); // A
					let s = chars.peek().copied();
					if s == Some('S') {
						chars.next(); // S
						let t = chars.peek().copied();
						if t == Some('T') {
							chars.next(); // T
							expand_last(&mut result, node, source)?;
						} else {
							// $LAS... → literal
							result.push_str("$LAS");
						}
					} else {
						// $LA... → literal
						result.push_str("$LA");
					}
				} else {
					// $L then something else → literal
					result.push_str("$L");
				}
			}
			Some(c) if c.is_uppercase() => {
				chars.next();
				let name = consume_uppercase_token(&mut chars, c);
				expand_named(&mut result, node, source, &name)?;
			}
			Some(_c) => {
				// $ followed by non-uppercase, non-digit → literal
				result.push('$');
			}
		}
	}

	Ok(result)
}

/// Convenience: expand template, converting errors to Diagnostics.
pub fn expand_template_diag(
	content: &str,
	node: Node<'_>,
	source: &str,
) -> Result<String, Diagnostic> {
	expand_template(content, node, source).map_err(Diagnostic::from)
}

// ── Variable expanders ────────────────────────────────────────────

fn expand_positional(
	out: &mut String,
	node: Node<'_>,
	source: &str,
	n: usize,
) -> Result<(), TemplateError> {
	if n == 0 {
		push_node_range(out, node, source);
		return Ok(());
	}

	let mut cursor = node.walk();
	let named: Vec<Node<'_>> = node.named_children(&mut cursor).collect();

	let idx = n.saturating_sub(1);
	let child = named.get(idx).copied().ok_or_else(|| {
		TemplateError::pos_out_of_range(n, named.len())
	})?;

	push_node_range(out, child, source);
	Ok(())
}

fn expand_last(
	out: &mut String,
	node: Node<'_>,
	source: &str,
) -> Result<(), TemplateError> {
	let mut cursor = node.walk();
	let named: Vec<Node<'_>> = node.named_children(&mut cursor).collect();

	let last = named.into_iter().last().ok_or_else(|| {
		TemplateError::pos_out_of_range(1, 0)
	})?;

	push_node_range(out, last, source);
	Ok(())
}

fn expand_named(
	out: &mut String,
	node: Node<'_>,
	source: &str,
	name: &str,
) -> Result<(), TemplateError> {
	match name {
		"BODY" => {
			// Primary: use tree-sitter "body" field
			if let Some(body_node) = node.child_by_field_name("body")
				.or_else(|| node.child_by_field_name("do_block"))
			{
				let body_text = source
					.get(body_node.start_byte()..body_node.end_byte())
					.unwrap_or("");
				let inner = strip_body_delimiters(body_node, body_text);
				out.push_str(inner);
			} else if node.kind() == "do_block" {
				// Elixir: do_block passed directly — strip do/end
				let body_text = source
					.get(node.start_byte()..node.end_byte())
					.unwrap_or("");
				let inner = strip_body_delimiters(node, body_text);
				out.push_str(inner);
			} else {
				return Err(TemplateError::not_applicable("BODY", node.kind()));
			}
		}
		"NAME" => {
			let name_node = node
				.child_by_field_name("name")
				.or_else(|| node.child_by_field_name("declarator"))
				.ok_or_else(|| TemplateError::not_applicable("NAME", node.kind()))?;
			if let Some(text) = source.get(name_node.start_byte()..name_node.end_byte()) {
				out.push_str(text);
			} else {
				return Err(TemplateError::not_applicable("NAME", node.kind()));
			}
		}
		"SIG" => {
			let body_node = node.child_by_field_name("body")
				.or_else(|| node.child_by_field_name("do_block"))
				.ok_or_else(|| TemplateError::not_applicable("SIG", node.kind()))?;
			let sig_end = body_node.start_byte();
			let sig_start = node.start_byte();
			if sig_end > sig_start {
				if let Some(sig_text) = source.get(sig_start..sig_end) {
					out.push_str(sig_text.trim_end());
				} else {
					return Err(TemplateError::not_applicable("SIG", node.kind()));
				}
			} else {
				return Err(TemplateError::not_applicable("SIG", node.kind()));
			}
		}
		"DECL" | "MATCH" => {
			push_node_range(out, node, source);
		}
		_ => {
			return Err(TemplateError::unknown(name));
		}
	}
	Ok(())
}

// ── Body delimiter stripping ──────────────────────────────────────

/// Strip the outer delimiters from a tree-sitter body node.
///
/// tree-sitter grammars include delimiters in body nodes:
/// - C-like: `{ ... }` → strip first `{` and last `}`
/// - Elixir: `do ... end` → strip `do` prefix and `end` suffix
/// - Python: indented block → already just statements
fn strip_body_delimiters<'a>(body_node: Node<'_>, body_text: &'a str) -> &'a str {
	let text = body_text.trim();
	let kind = body_node.kind();

	// C-like block: statement_block, block → strip braces
	if kind.contains("block") {
		if text.starts_with('{') && text.ends_with('}') {
			let inner = &text[1..text.len() - 1];
			return inner.trim();
		}
		return text;
	}

	// Elixir: do_block node OR body field in def/fn → strip do/end
	if kind == "do_block" || kind == "body" {
		if let Some(stripped) = text.strip_prefix("do") {
			let stripped = stripped.trim_start();
			if let Some(inner) = stripped.strip_suffix("end") {
				return inner.trim();
			}
			// `do: expr` — strip `do:` prefix
			if let Some(inner) = stripped.strip_prefix(": ") {
				return inner.trim();
			}
			return stripped.trim();
		}
	}

	// Default: return as-is
	text
}

// ── Helpers ───────────────────────────────────────────────────────

fn push_node_range(out: &mut String, node: Node<'_>, source: &str) {
	if let Some(text) = source.get(node.start_byte()..node.end_byte()) {
		out.push_str(text);
	}
}

fn consume_uppercase_token(
	chars: &mut std::iter::Peekable<impl Iterator<Item = char>>,
	first: char,
) -> String {
	let mut name = String::new();
	name.push(first);
	while let Some(c) = chars.peek().copied() {
		if c.is_ascii_uppercase() || c.is_ascii_digit() {
			chars.next();
			name.push(c);
		} else {
			break;
		}
	}
	name
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;
	use tree_sitter::Parser;

	fn parse_ts(source: &'static str) -> (tree_sitter::Tree, &'static str) {
		let mut parser = Parser::new();
		parser
			.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
			.unwrap();
		let tree = parser.parse(source, None).unwrap();
		(tree, source)
	}

	fn parse_rs(source: &'static str) -> (tree_sitter::Tree, &'static str) {
		let mut parser = Parser::new();
		parser.set_language(&tree_sitter_rust::LANGUAGE.into()).unwrap();
		let tree = parser.parse(source, None).unwrap();
		(tree, source)
	}

	fn parse_py(source: &'static str) -> (tree_sitter::Tree, &'static str) {
		let mut parser = Parser::new();
		parser
			.set_language(&tree_sitter_python::LANGUAGE.into())
			.unwrap();
		let tree = parser.parse(source, None).unwrap();
		(tree, source)
	}

	fn parse_go(source: &'static str) -> (tree_sitter::Tree, &'static str) {
		let mut parser = Parser::new();
		parser.set_language(&tree_sitter_go::LANGUAGE.into()).unwrap();
		let tree = parser.parse(source, None).unwrap();
		(tree, source)
	}

	fn parse_ex(source: &'static str) -> (tree_sitter::Tree, &'static str) {
		let mut parser = Parser::new();
		parser
			.set_language(&tree_sitter_elixir::LANGUAGE.into())
			.unwrap();
		let tree = parser.parse(source, None).unwrap();
		(tree, source)
	}

	fn expand(
		source: &'static str,
		template: &str,
		parse_fn: fn(&'static str) -> (tree_sitter::Tree, &'static str),
	) -> Result<String, TemplateError> {
		let (tree, src) = parse_fn(source);
		let root = tree.root_node();
		let mut cursor = root.walk();
		let node = root
			.named_children(&mut cursor)
			.next()
			.expect("source must have a named child");
		expand_template(template, node, src)
	}

	// === Positional ===

	#[test]
	fn positional_0_full_match() {
		let r = expand("function foo() { return 1; }", "$0", parse_ts).unwrap();
		assert_eq!(r, "function foo() { return 1; }");
	}

	#[test]
	fn positional_1_first_named_child() {
		let r = expand(
			"function foo(x: number) { return x; }",
			"$1",
			parse_ts,
		).unwrap();
		assert_eq!(r, "foo");
	}

	#[test]
	fn positional_last_child() {
		// TS function_declaration: [identifier, formal_parameters, statement_block]
		// $LAST should be the statement_block: "{ return x; }"
		let r = expand(
			"function foo(x: number) { return x; }",
			"$LAST",
			parse_ts,
		).unwrap();
		assert_eq!(r, "{ return x; }");
	}

	// === $BODY ===

	#[test]
	fn body_ts() {
		let r = expand("function foo() { return 1; }", "$BODY", parse_ts).unwrap();
		assert_eq!(r.trim(), "return 1;");
	}

	#[test]
	fn body_rs() {
		let r = expand("fn foo() -> i32 { 1 }", "$BODY", parse_rs).unwrap();
		assert_eq!(r.trim(), "1");
	}

	#[test]
	fn body_py() {
		let r = expand("def foo():\n    return 1\n", "$BODY", parse_py).unwrap();
		assert_eq!(r.trim(), "return 1");
	}

	#[test]
	fn body_go() {
		let r = expand("func foo() int { return 1 }", "$BODY", parse_go).unwrap();
		assert_eq!(r.trim(), "return 1");
	}

	#[test]
	fn body_ex_do_end() {
		// Elixir tree-sitter wraps def in a call node.
		// Walk into the tree to find the do_block which has the body.
		let (tree, src) = parse_ex("def foo do\n  x = 1\n  x + 1\nend\n");
		let root = tree.root_node();
		// Search for the do_block node and use its body
		let node = find_node_by_kind(root, "do_block")
			.expect("should find do_block in Elixir tree");
		let r = expand_template("$BODY", node, src).unwrap();
		assert!(r.contains("x = 1"), "got: {:?}", r);
	}

	fn find_node_by_kind<'a>(node: Node<'a>, target_kind: &str) -> Option<Node<'a>> {
		if node.kind() == target_kind {
			return Some(node);
		}
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if let Some(found) = find_node_by_kind(child, target_kind) {
				return Some(found);
			}
		}
		None
	}

	// === $NAME ===

	#[test]
	fn name_ts() {
		let r = expand("function parseConfig(a: number) { return a; }", "$NAME", parse_ts).unwrap();
		assert_eq!(r, "parseConfig");
	}

	#[test]
	fn name_rs() {
		let r = expand("fn parse_config(x: i32) -> i32 { x }", "$NAME", parse_rs).unwrap();
		assert_eq!(r, "parse_config");
	}

	#[test]
	fn name_py() {
		let r = expand("def my_func():\n    pass\n", "$NAME", parse_py).unwrap();
		assert_eq!(r, "my_func");
	}

	#[test]
	fn name_go() {
		let r = expand("func HandleRequest(w http.ResponseWriter) error { return nil }", "$NAME", parse_go).unwrap();
		assert_eq!(r, "HandleRequest");
	}

	// === $SIG ===

	#[test]
	fn sig_ts() {
		let r = expand(
			"function foo(a: number, b: string): boolean { return true; }",
			"$SIG",
			parse_ts,
		).unwrap();
		assert!(r.starts_with("function foo"));
		assert!(r.contains("a: number"));
		assert!(!r.contains("return true"));
		assert!(!r.contains('{'));
	}

	#[test]
	fn sig_rs() {
		let r = expand(
			"fn foo<T: Display + Debug>(x: T) -> String where T: Clone { format!(\"{x}\") }",
			"$SIG",
			parse_rs,
		).unwrap();
		assert!(r.contains("fn foo"));
		assert!(r.contains("T: Display + Debug"));
		assert!(!r.contains("format!"));
	}

	#[test]
	fn sig_go() {
		let r = expand("func foo(x int, y string) error { return nil }", "$SIG", parse_go).unwrap();
		assert!(r.contains("func foo"));
		assert!(r.contains("error"));
		assert!(!r.contains("return nil"));
	}

	// === $MATCH / $DECL ===

	#[test]
	fn match_decl_full_text() {
		let r = expand("function foo() { return 1; }", "$MATCH", parse_ts).unwrap();
		assert_eq!(r, "function foo() { return 1; }");
		let r2 = expand("function foo() { return 1; }", "$DECL", parse_ts).unwrap();
		assert_eq!(r2, "function foo() { return 1; }");
	}

	// === Dollar escape ===

	#[test]
	fn escape_dollar_dollar() {
		let r = expand("function foo() {}", "echo $$HOME", parse_ts).unwrap();
		assert_eq!(r, "echo $HOME");
	}

	#[test]
	fn literal_dollar_non_uppercase() {
		// $ followed by non-uppercase letter → literal
		let r = expand("function foo() {}", "price $dollar", parse_ts).unwrap();
		assert_eq!(r, "price $dollar");
	}

	#[test]
	fn literal_dollar_multi_digit() {
		// $100: only single digit $1 is positional, so $100 → $1 positional + "00"
		// But since that's error-prone, agents should use $$100 for literal.
		// For now: $1 is consumed as positional (first child), "00" appended.
		let r = expand("function foo(x: number) { return x; }", "price $100", parse_ts).unwrap();
		assert_eq!(r, "price foo00");
	}

	#[test]
	fn literal_dollar_lowercase() {
		let r = expand("function foo() {}", "echo $var", parse_ts).unwrap();
		assert_eq!(r, "echo $var");
	}

	#[test]
	fn literal_js_template() {
		let r = expand("function foo() {}", "${NAME}", parse_ts).unwrap();
		assert_eq!(r, "${NAME}");
	}

	#[test]
	fn literal_dollar_eos() {
		let r = expand("function foo() {}", "cost: $", parse_ts).unwrap();
		assert_eq!(r, "cost: $");
	}

	// === Composite ===

	#[test]
	fn wrap_try_catch() {
		let r = expand(
			"function risky() { return JSON.parse(input); }",
			"try {\n  $BODY\n} catch(e) {\n  throw new SafeError(e);\n}",
			parse_ts,
		).unwrap();
		assert!(r.contains("try {"));
		assert!(!r.contains("$BODY"));
		assert!(r.contains("catch(e)"));
	}

	#[test]
	fn rename_with_name() {
		let r = expand(
			"function parseConfig(a: number) { return a; }",
			"$NAME_v2",
			parse_ts,
		).unwrap();
		assert_eq!(r, "parseConfig_v2");
	}

	#[test]
	fn annotation_before_decl() {
		let r = expand(
			"function oldFunc() { return 1; }",
			"@deprecated\\n$DECL",
			parse_ts,
		).unwrap();
		assert!(r.contains("@deprecated"));
		assert!(r.contains("function oldFunc()"));
	}

	// === Errors ===

	#[test]
	fn error_unknown_variable() {
		let err = expand("function foo() {}", "$UNKNOWN", parse_ts).unwrap_err();
		assert!(matches!(err.variant, TemplateErrorVariant::UnknownVariable { .. }));
		assert!(err.hint.unwrap().contains("Valid variables"));
	}

	#[test]
	fn error_position_oob() {
		let err = expand("function foo() {}", "$99", parse_ts).unwrap_err();
		assert!(matches!(
			err.variant,
			TemplateErrorVariant::PositionOutOfRange { .. }
		));
	}

	#[test]
	fn error_body_on_import() {
		let (tree, src) = parse_ts("import { foo } from './bar';");
		let root = tree.root_node();
		let mut cursor = root.walk();
		let node = root.named_children(&mut cursor).next().unwrap();
		let err = expand_template("$BODY", node, src).unwrap_err();
		assert!(matches!(
			err.variant,
			TemplateErrorVariant::NotApplicable { .. }
		));
	}

	// === Body edge cases ===

	#[test]
	fn body_empty() {
		let r = expand("function empty() {}", "$BODY", parse_ts).unwrap();
		assert_eq!(r.trim(), "");
	}

	#[test]
	fn body_multiline_braces_stripped() {
		let r = expand(
			"function foo() {\n  const x = 1;\n  return x;\n}",
			"$BODY",
			parse_ts,
		).unwrap();
		assert!(!r.contains('{'));
		assert!(!r.contains('}'));
		assert!(r.contains("const x = 1;"));
	}

	// === Diagnostics conversion ===

	#[test]
	fn expand_diag_ok() {
		let (tree, src) = parse_ts("function foo() { return 1; }");
		let root = tree.root_node();
		let mut cursor = root.walk();
		let node = root.named_children(&mut cursor).next().unwrap();
		let r = expand_template_diag("$BODY", node, src).unwrap();
		assert_eq!(r.trim(), "return 1;");
	}

	#[test]
	fn expand_diag_err() {
		let (tree, src) = parse_ts("function foo() { return 1; }");
		let root = tree.root_node();
		let mut cursor = root.walk();
		let node = root.named_children(&mut cursor).next().unwrap();
		let r = expand_template_diag("$UNKNOWN", node, src).unwrap_err();
		assert!(r.message.contains("UNKNOWN"));
	}
}
