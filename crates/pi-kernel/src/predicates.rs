use pi_code_path::{ast::Predicate, dialect::LanguageDialect};
use tree_sitter::Node;

/// Evaluate a simple predicate that does not require subquery evaluation.
///
/// Positional predicates (`Ordinal`, `Range`) are handled by the caller
/// after result-set collection.  `HasDescendant` / `HasAncestor` are also
/// handled by the walker so that it can supply a subquery evaluator.
pub fn eval(pred: &Predicate, node: &Node, src: &str, dialect: &LanguageDialect) -> bool {
	match pred {
		Predicate::Ordinal(_) | Predicate::Range { .. } => true,
		Predicate::KindFilter(kind) => node.kind() == kind.as_str(),
		Predicate::AnchorFilter(name) => dialect
			.anchors
			.iter()
			.any(|a| a.name == name.as_str() && (a.matcher)(node, src)),
		Predicate::Attribute { name, value } => {
			if name == "name" {
				return matches_name_attribute(node, src, value);
			}
			// v1: accept all non-"name" attributes.
			true
		},
		Predicate::TextMatch(pattern) => {
			// TODO: switch to real regex when regex is directly available.
			if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
				return text.contains(pattern.as_str());
			}
			false
		},
		Predicate::LiteralMatch(lit) => {
			if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
				return text.contains(lit.as_str());
			}
			false
		},
		Predicate::Compare { .. } => false,
		Predicate::Flag(_) => true,
		Predicate::Length { .. } => false,
		Predicate::Count { .. } => false,
		Predicate::HasDescendant(_) | Predicate::HasAncestor(_) => {
			// Delegated to the walker which owns subquery evaluation.
			true
		},
		Predicate::SymbolSlice { .. } => {
			// FEAT-718: SymbolSlice does not filter — it transforms matched
			// symbol nodes into sliced text bodies. The walker applies it.
			true
		},
	}
}
/// Match a `[name=VALUE]` attribute predicate against a node.
///
/// Resolution order, first hit wins:
/// 1. `name` field (declarations: fn/class/struct/var with a name child).
/// 2. callee field — `function` (TS/JS/Py/Go `call_expression`, Rust
///    `call_expression`) or `macro` (Rust `macro_invocation`). This is what
///    makes `§call[name=console.log]` resolve: a call has no `name` field, its
///    callee lives in the `function`/`macro` field.
/// 3. full-node text (last resort for leaf nodes whose identity == their text).
fn matches_name_attribute(node: &Node, src: &str, value: &str) -> bool {
	let text_of = |n: &Node| src.get(n.start_byte()..n.end_byte());

	if let Some(child) = node.child_by_field_name("name")
		&& text_of(&child) == Some(value)
	{
		return true;
	}

	// Callee of a call/macro lives in the `function`/`macro` field, not `name`.
	for field in ["function", "macro"] {
		if let Some(callee) = node.child_by_field_name(field)
			&& text_of(&callee) == Some(value)
		{
			return true;
		}
	}

	text_of(node) == Some(value)
}
