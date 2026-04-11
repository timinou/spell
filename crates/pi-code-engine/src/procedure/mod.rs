mod activation;
mod rules;
mod selector;

pub use activation::{ActivationBuilder, ActivationRule, Position};
pub use rules::{exclude, irule, matches_rule_expr, rule, rx, types, RuleExpr};
pub use selector::{ChildFilter, ChildFilterBuilder, Selector, SelectorBuilder, Target};

use tree_sitter::Node;

use crate::language::LanguageProfile;

pub struct Procedure {
	pub activation_rules: Vec<ActivationRule>,
	pub selector: Option<Selector>,
}

pub struct ProcedureResult {
	pub matched_nodes: Vec<MatchedNode>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mark {
	Match,
	Discard,
}

pub struct MatchedNode {
	pub node_id: usize,
	pub byte_range: std::ops::Range<usize>,
	pub mark: Mark,
}

pub struct ProcedureBuilder {
	activation_rules: Vec<ActivationRule>,
	selector: Option<Selector>,
}

impl Procedure {
	pub fn builder() -> ProcedureBuilder {
		ProcedureBuilder { activation_rules: Vec::new(), selector: None }
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

impl ProcedureBuilder {
	pub fn activate<F>(mut self, f: F) -> Self
	where
		F: FnOnce(ActivationBuilder) -> ActivationBuilder,
	{
		self.activation_rules.push(f(ActivationBuilder::new()).build());
		self
	}

	pub fn select<F>(mut self, f: F) -> Self
	where
		F: FnOnce(SelectorBuilder) -> SelectorBuilder,
	{
		self.selector = Some(f(SelectorBuilder::new()).build());
		self
	}

	pub fn build(self) -> Procedure {
		Procedure { activation_rules: self.activation_rules, selector: self.selector }
	}
}

fn matches_activation(
	rule: &ActivationRule,
	node: &Node<'_>,
	point: usize,
	profile: &LanguageProfile,
) -> bool {
	if !matches_position(rule.position, node, point) || !matches_rule_expr(&rule.nodes, node, profile) {
		return false;
	}
	if let Some(parent_expr) = &rule.has_parent {
		let Some(parent) = node.parent() else { return false; };
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
		Target::Grandparent => node.parent().and_then(|parent| parent.parent()).unwrap_or(*node),
	};

	match &selector.child_filter {
		None => vec![selected_node(&target, Mark::Match)],
		Some(filter) => target
			.children(&mut target.walk())
			.map(|child| MatchedNode {
				node_id: child.id(),
				byte_range: child.start_byte()..child.end_byte(),
				mark: if filter.discard_types.iter().any(|kind| kind == child.kind()) { Mark::Discard } else { filter.default_mark },
			})
			.collect(),
	}
}

fn selected_node(node: &Node<'_>, mark: Mark) -> MatchedNode {
	MatchedNode { node_id: node.id(), byte_range: node.start_byte()..node.end_byte(), mark }
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn parse_ts(source: &str) -> (tree_sitter::Tree, LanguageProfile) {
		let registry = LanguageRegistry::with_builtins().expect("builtins");
		let profile = registry.get(&LanguageId::new("typescript")).expect("ts").clone();
		let mut parser = tree_sitter::Parser::new();
		parser.set_language(&profile.ts_language).expect("language");
		let tree = parser.parse(source, None).expect("tree");
		(tree, profile)
	}

	fn node_at_byte<'a>(tree: &'a tree_sitter::Tree, byte: usize) -> Node<'a> {
		tree.root_node()
			.named_descendant_for_byte_range(byte, byte)
			.unwrap_or_else(|| tree.root_node().descendant_for_byte_range(byte, byte).expect("node"))
	}

	#[test]
	fn test_activation_by_type() {
		let (tree, profile) = parse_ts("foo(ident)");
		let node = node_at_byte(&tree, 4);
		let proc = Procedure::builder().activate(|a| a.nodes(types(&["identifier"]))).build();
		let result = apply_procedure(&proc, &node, 4, &profile).expect("match");
		assert_eq!(result.matched_nodes.len(), 1);
		assert_eq!(result.matched_nodes[0].mark, Mark::Match);
	}

	#[test]
	fn test_activation_with_parent() {
		let (tree, profile) = parse_ts("foo(bar)");
		let node = node_at_byte(&tree, 4);
		let proc = Procedure::builder().activate(|a| a.nodes(types(&["identifier"])).has_parent(types(&["call_expression"]))).build();
		assert!(apply_procedure(&proc, &node, 4, &profile).is_some());
	}

	#[test]
	fn test_selector_marks_children() {
		let (tree, profile) = parse_ts("foo(bar, baz)");
		let node = node_at_byte(&tree, 0);
		let proc = Procedure::builder()
			.activate(|a| a.nodes(types(&["call_expression"])))
			.select(|s| s.choose(Target::Self_).match_children(|m| m.discard(&["comma"]).default_mark(Mark::Match)))
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
			.activate(|a| a.nodes(rule("expression")).has_fields(vec!["arguments".to_string()]).position(Position::At))
			.select(|s| s.choose(Target::Parent))
			.build();
		assert_eq!(proc.activation_rules.len(), 1);
		assert!(proc.selector.is_some());
	}
}
