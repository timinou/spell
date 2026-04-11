use crate::procedure::rules::RuleExpr;

#[derive(Clone, Copy, PartialEq)]
pub enum Position {
	Any,
	At,
	In,
}

pub struct ActivationRule {
	pub nodes: RuleExpr,
	pub position: Position,
	pub has_parent: Option<RuleExpr>,
	pub has_ancestor: Option<RuleExpr>,
	pub has_fields: Option<Vec<String>>,
}

pub struct ActivationBuilder {
	rule: ActivationRule,
}

impl ActivationBuilder {
	pub(crate) fn new() -> Self {
		Self {
			rule: ActivationRule {
				nodes: RuleExpr::All,
				position: Position::Any,
				has_parent: None,
				has_ancestor: None,
				has_fields: None,
			},
		}
	}

	pub fn nodes(mut self, rule: RuleExpr) -> Self {
		self.rule.nodes = rule;
		self
	}

	pub fn has_parent(mut self, rule: RuleExpr) -> Self {
		self.rule.has_parent = Some(rule);
		self
	}

	pub fn has_ancestor(mut self, rule: RuleExpr) -> Self {
		self.rule.has_ancestor = Some(rule);
		self
	}

	pub fn has_fields(mut self, fields: Vec<String>) -> Self {
		self.rule.has_fields = Some(fields);
		self
	}

	pub fn position(mut self, position: Position) -> Self {
		self.rule.position = position;
		self
	}

	pub(crate) fn build(self) -> ActivationRule {
		self.rule
	}
}
