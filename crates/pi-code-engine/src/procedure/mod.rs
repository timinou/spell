mod activation;
mod rules;
mod selector;

use std::{fmt, sync::Arc};

pub use activation::{ActivationBuilder, ActivationRule, Position};
pub use rules::{RuleExpr, exclude, irule, matches_rule_expr, rule, rx, types};
pub use selector::{ChildFilter, ChildFilterBuilder, Selector, SelectorBuilder, Target};
use tree_sitter::Node;

use crate::{TextEdit, error::CodeEngineError, language::LanguageProfile};

/// Declarative transform applied to each matched node.
///
/// When `Custom` is used, it indicates the DSL should eventually be extended
/// to express this operation declaratively. Treat `Custom` as a flag for
/// improvement, not a permanent escape hatch.
type CustomTransform = dyn Fn(&str, &serde_json::Value) -> crate::Result<String> + Send + Sync;

#[derive(Clone)]
pub enum Transform {
	/// Remove N characters from the start of each matched node's text.
	TrimStart { count: usize },
	/// Remove N characters from the end of each matched node's text.
	TrimEnd { count: usize },
	/// Prepend text to each matched node.
	Prepend { text: String },
	/// Append text to each matched node.
	Append { text: String },
	/// Replace matched node text using regex.
	RegexReplace { pattern: String, replacement: String },
	/// Delete matched nodes entirely.
	Delete,
	/// Replace the content of matched nodes with `options.content`.
	ReplaceContent { content_field: Option<String> },
	/// Escape hatch for transforms that don't fit declarative patterns.
	Custom(Arc<CustomTransform>),
}

impl fmt::Debug for Transform {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::TrimStart { count } => f.debug_struct("TrimStart").field("count", count).finish(),
			Self::TrimEnd { count } => f.debug_struct("TrimEnd").field("count", count).finish(),
			Self::Prepend { text } => f.debug_struct("Prepend").field("text", text).finish(),
			Self::Append { text } => f.debug_struct("Append").field("text", text).finish(),
			Self::RegexReplace { pattern, replacement } => f
				.debug_struct("RegexReplace")
				.field("pattern", pattern)
				.field("replacement", replacement)
				.finish(),
			Self::Delete => f.write_str("Delete"),
			Self::ReplaceContent { content_field } => f
				.debug_struct("ReplaceContent")
				.field("content_field", content_field)
				.finish(),
			Self::Custom(_) => f.write_str("Custom(fn)"),
		}
	}
}

#[derive(Debug, Clone)]
pub struct Procedure {
	pub name:             String,
	pub description:      String,
	pub activation_rules: Vec<ActivationRule>,
	pub selector:         Option<Selector>,
	pub transform:        Transform,
}

pub struct ProcedureResult {
	pub matched_nodes: Vec<MatchedNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
	Match,
	Discard,
}

pub struct MatchedNode {
	pub node_id:    usize,
	pub byte_range: std::ops::Range<usize>,
	pub mark:       Mark,
}

pub struct ProcedureBuilder {
	name:             String,
	description:      String,
	activation_rules: Vec<ActivationRule>,
	selector:         Option<Selector>,
	transform:        Transform,
}

impl Procedure {
	pub const fn builder() -> ProcedureBuilder {
		ProcedureBuilder {
			name:             String::new(),
			description:      String::new(),
			activation_rules: Vec::new(),
			selector:         None,
			transform:        Transform::Append { text: String::new() },
		}
	}
}

pub fn apply_procedure(
	procedure: &Procedure,
	node: &Node<'_>,
	point: usize,
	profile: &LanguageProfile,
) -> Option<ProcedureResult> {
	let _activation = procedure
		.activation_rules
		.iter()
		.find(|rule| matches_activation(rule, node, point, profile))?;

	let matched_nodes = match procedure.selector.as_ref() {
		None => vec![selected_node(node, Mark::Match)],
		Some(selector) => select_nodes(selector, node),
	};

	Some(ProcedureResult { matched_nodes })
}

pub fn apply_procedure_transform(
	procedure: &Procedure,
	source: &str,
	matched_nodes: &[MatchedNode],
	options: &serde_json::Value,
) -> crate::Result<Vec<TextEdit>> {
	let mut edits = Vec::new();
	for node in matched_nodes {
		if node.mark != Mark::Match {
			continue;
		}

		let Some(text) = source.get(node.byte_range.clone()) else {
			return Err(CodeEngineError::Edit(format!(
				"Matched node range {}..{} is out of bounds",
				node.byte_range.start, node.byte_range.end
			)));
		};

		let new_text = match &procedure.transform {
			Transform::TrimStart { count } => text.chars().skip(*count).collect(),
			Transform::TrimEnd { count } => {
				let chars: Vec<char> = text.chars().collect();
				chars[..chars.len().saturating_sub(*count)].iter().collect()
			},
			Transform::Prepend { text: prefix } => format!("{prefix}{text}"),
			Transform::Append { text: suffix } => format!("{text}{suffix}"),
			Transform::RegexReplace { pattern, replacement } => {
				let re =
					regex::Regex::new(pattern).map_err(|e| CodeEngineError::Edit(e.to_string()))?;
				re.replace_all(text, replacement.as_str()).into_owned()
			},
			Transform::Delete => String::new(),
			Transform::ReplaceContent { content_field } => {
				let field = content_field.as_deref().unwrap_or("content");
				options
					.get(field)
					.and_then(serde_json::Value::as_str)
					.unwrap_or("")
					.to_string()
			},
			Transform::Custom(f) => f(text, options)?,
		};

		edits.push(TextEdit {
			start_byte: node.byte_range.start,
			old_end_byte: node.byte_range.end,
			new_text,
		});
	}

	Ok(edits)
}

impl ProcedureBuilder {
	pub fn name(mut self, name: impl Into<String>) -> Self {
		self.name = name.into();
		self
	}

	pub fn description(mut self, description: impl Into<String>) -> Self {
		self.description = description.into();
		self
	}

	pub fn activate<F>(mut self, f: F) -> Self
	where
		F: FnOnce(ActivationBuilder) -> ActivationBuilder,
	{
		self
			.activation_rules
			.push(f(ActivationBuilder::new()).build());
		self
	}

	pub fn select<F>(mut self, f: F) -> Self
	where
		F: FnOnce(SelectorBuilder) -> SelectorBuilder,
	{
		self.selector = Some(f(SelectorBuilder::new()).build());
		self
	}

	pub fn transform(mut self, transform: Transform) -> Self {
		self.transform = transform;
		self
	}

	pub fn build(self) -> Procedure {
		Procedure {
			name:             self.name,
			description:      self.description,
			activation_rules: self.activation_rules,
			selector:         self.selector,
			transform:        self.transform,
		}
	}
}

fn matches_activation(
	rule: &ActivationRule,
	node: &Node<'_>,
	point: usize,
	profile: &LanguageProfile,
) -> bool {
	if !matches_position(rule.position, node, point)
		|| !matches_rule_expr(&rule.nodes, node, profile)
	{
		return false;
	}
	if let Some(parent_expr) = &rule.has_parent {
		let Some(parent) = node.parent() else {
			return false;
		};
		if !matches_rule_expr(parent_expr, &parent, profile) {
			return false;
		}
	}
	if let Some(ancestor_expr) = &rule.has_ancestor {
		let mut ancestor = node.parent();
		let mut found = false;
		while let Some(current) = ancestor {
			if matches_rule_expr(ancestor_expr, &current, profile) {
				found = true;
				break;
			}
			ancestor = current.parent();
		}
		if !found {
			return false;
		}
	}
	if let Some(fields) = &rule.has_fields {
		for field in fields {
			if node.child_by_field_name(field).is_none() {
				return false;
			}
		}
	}
	true
}

fn matches_position(position: Position, node: &Node<'_>, point: usize) -> bool {
	match position {
		Position::Any => true,
		Position::At | Position::In => (node.start_byte()..=node.end_byte()).contains(&point),
	}
}

fn select_nodes(selector: &Selector, node: &Node<'_>) -> Vec<MatchedNode> {
	let target = match selector.target {
		Target::Self_ => *node,
		Target::Parent => node.parent().unwrap_or(*node),
		Target::Grandparent => node
			.parent()
			.and_then(|parent| parent.parent())
			.unwrap_or(*node),
	};

	match &selector.child_filter {
		None => vec![selected_node(&target, Mark::Match)],
		Some(filter) => target
			.children(&mut target.walk())
			.map(|child| MatchedNode {
				node_id:    child.id(),
				byte_range: child.start_byte()..child.end_byte(),
				mark:       if filter.discard_types.iter().any(|kind| kind == child.kind()) {
					Mark::Discard
				} else {
					filter.default_mark
				},
			})
			.collect(),
	}
}

fn selected_node(node: &Node<'_>, mark: Mark) -> MatchedNode {
	MatchedNode { node_id: node.id(), byte_range: node.start_byte()..node.end_byte(), mark }
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn parse_ts(source: &str) -> (tree_sitter::Tree, LanguageProfile) {
		let registry = LanguageRegistry::with_builtins().expect("builtins");
		let profile = registry
			.get(&LanguageId::new("typescript"))
			.expect("ts")
			.clone();
		let mut parser = tree_sitter::Parser::new();
		parser.set_language(&profile.ts_language).expect("language");
		let tree = parser.parse(source, None).expect("tree");
		(tree, profile)
	}

	fn node_at_byte<'a>(tree: &'a tree_sitter::Tree, byte: usize) -> Node<'a> {
		tree
			.root_node()
			.named_descendant_for_byte_range(byte, byte)
			.unwrap_or_else(|| {
				tree
					.root_node()
					.descendant_for_byte_range(byte, byte)
					.expect("node")
			})
	}

	#[test]
	fn test_activation_by_type() {
		let (tree, profile) = parse_ts("foo(ident)");
		let node = node_at_byte(&tree, 4);
		let proc = Procedure::builder()
			.activate(|a| a.nodes(types(&["identifier"])))
			.build();
		let result = apply_procedure(&proc, &node, 4, &profile).expect("match");
		assert_eq!(result.matched_nodes.len(), 1);
		assert_eq!(result.matched_nodes[0].mark, Mark::Match);
	}

	#[test]
	fn test_activation_with_parent() {
		let (tree, profile) = parse_ts("foo(bar)");
		let node = node_at_byte(&tree, 4);
		let proc = Procedure::builder()
			.activate(|a| {
				a.nodes(types(&["identifier"]))
					.has_ancestor(types(&["call_expression"]))
			})
			.build();
		assert!(apply_procedure(&proc, &node, 4, &profile).is_some());
	}

	#[test]
	fn test_selector_marks_children() {
		let (tree, profile) = parse_ts("foo(bar, baz)");
		let expr_stmt = tree.root_node().named_child(0).expect("expr_stmt");
		let node = expr_stmt.named_child(0).unwrap_or(expr_stmt);
		let proc = Procedure::builder()
			.activate(|a| a.nodes(types(&["call_expression"])))
			.select(|s| {
				s.choose(Target::Self_)
					.match_children(|m| m.discard(&["comma"]).default_mark(Mark::Match))
			})
			.build();
		let result = apply_procedure(&proc, &node, 0, &profile).expect("match");
		assert!(!result.matched_nodes.is_empty());
	}

	#[test]
	fn test_rule_expr_types() {
		let (tree, profile) = parse_ts("foo");
		let node = node_at_byte(&tree, 0);
		assert!(matches_rule_expr(&types(&["identifier"]), &node, &profile));
	}

	#[test]
	fn test_rule_expr_regex() {
		let (tree, profile) = parse_ts("foo");
		let node = node_at_byte(&tree, 0);
		assert!(matches_rule_expr(&rx("id.*"), &node, &profile));
	}

	#[test]
	fn test_rule_expr_exclude() {
		let (tree, profile) = parse_ts("foo");
		let node = node_at_byte(&tree, 0);
		assert!(matches_rule_expr(&exclude(rule("identifier"), types(&["string"])), &node, &profile));
	}

	#[test]
	fn test_builder_api() {
		let proc = Procedure::builder()
			.name("noop")
			.description("No-op")
			.activate(|a| {
				a.nodes(rule("expression"))
					.has_fields(vec!["arguments".to_string()])
					.position(Position::At)
			})
			.select(|s| s.choose(Target::Parent))
			.transform(Transform::Delete)
			.build();
		assert_eq!(proc.name, "noop");
		assert_eq!(proc.description, "No-op");
		assert_eq!(proc.activation_rules.len(), 1);
		assert!(proc.selector.is_some());
	}

	#[test]
	fn test_apply_transform_trim_start() {
		let proc = Procedure::builder()
			.transform(Transform::TrimStart { count: 1 })
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"## Heading",
			&[MatchedNode { node_id: 1, byte_range: 0..10, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "# Heading");
	}

	#[test]
	fn test_apply_transform_trim_end() {
		let proc = Procedure::builder()
			.transform(Transform::TrimEnd { count: 1 })
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"=== Heading",
			&[MatchedNode { node_id: 1, byte_range: 0..11, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "=== Headin");
	}

	#[test]
	fn test_apply_transform_prepend() {
		let proc = Procedure::builder()
			.transform(Transform::Prepend { text: "#".into() })
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"# Heading",
			&[MatchedNode { node_id: 1, byte_range: 0..9, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "## Heading");
	}

	#[test]
	fn test_apply_transform_append() {
		let proc = Procedure::builder()
			.transform(Transform::Append { text: "!".into() })
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"Hello",
			&[MatchedNode { node_id: 1, byte_range: 0..5, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "Hello!");
	}

	#[test]
	fn test_apply_transform_delete() {
		let proc = Procedure::builder().transform(Transform::Delete).build();
		let edits = apply_procedure_transform(
			&proc,
			"Hello",
			&[MatchedNode { node_id: 1, byte_range: 0..5, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "");
	}

	#[test]
	fn test_apply_transform_regex_replace() {
		let proc = Procedure::builder()
			.transform(Transform::RegexReplace {
				pattern:     "Heading".into(),
				replacement: "Title".into(),
			})
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"# Heading",
			&[MatchedNode { node_id: 1, byte_range: 0..9, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "# Title");
	}

	#[test]
	fn test_apply_transform_replace_content() {
		let proc = Procedure::builder()
			.transform(Transform::ReplaceContent { content_field: None })
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"old",
			&[MatchedNode { node_id: 1, byte_range: 0..3, mark: Mark::Match }],
			&serde_json::json!({ "content": "new" }),
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "new");
	}

	#[test]
	fn test_apply_transform_custom() {
		let proc = Procedure::builder()
			.transform(Transform::Custom(Arc::new(|text, _| Ok(text.to_uppercase()))))
			.build();
		let edits = apply_procedure_transform(
			&proc,
			"hello",
			&[MatchedNode { node_id: 1, byte_range: 0..5, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap();
		assert_eq!(edits[0].new_text, "HELLO");
	}

	#[test]
	fn test_apply_transform_invalid_regex_errors() {
		let proc = Procedure::builder()
			.transform(Transform::RegexReplace { pattern: "(".into(), replacement: "x".into() })
			.build();
		let err = apply_procedure_transform(
			&proc,
			"hello",
			&[MatchedNode { node_id: 1, byte_range: 0..5, mark: Mark::Match }],
			&serde_json::Value::Null,
		)
		.unwrap_err();
		assert!(err.to_string().contains("regex") || err.to_string().contains("unclosed"));
	}
}
