use regex::Regex;

use crate::language::LanguageProfile;

#[derive(Clone, PartialEq)]
pub enum RuleExpr {
	Types(Vec<String>),
	Rule(String),
	InverseRule(String),
	Regex(String),
	Exclude { include: Box<RuleExpr>, exclude: Box<RuleExpr> },
	All,
}

pub fn types(names: &[&str]) -> RuleExpr {
	RuleExpr::Types(names.iter().map(|name| (*name).to_string()).collect())
}

pub fn rule(name: &str) -> RuleExpr {
	RuleExpr::Rule(name.to_string())
}

pub fn irule(name: &str) -> RuleExpr {
	RuleExpr::InverseRule(name.to_string())
}

pub fn rx(pattern: &str) -> RuleExpr {
	RuleExpr::Regex(pattern.to_string())
}

pub fn exclude(include: RuleExpr, exclude: RuleExpr) -> RuleExpr {
	RuleExpr::Exclude { include: Box::new(include), exclude: Box::new(exclude) }
}

pub fn matches_rule_expr(expr: &RuleExpr, node: &tree_sitter::Node<'_>, profile: &LanguageProfile) -> bool {
	match expr {
		RuleExpr::Types(names) => names.iter().any(|name| name == node.kind()),
		RuleExpr::Rule(name) => profile
			.production_rules
			.get(name)
			.is_some_and(|rule| rule.unnamed_children.iter().any(|child| child == node.kind()) || rule.fields.values().any(|children| children.iter().any(|child| child == node.kind()))),
		RuleExpr::InverseRule(name) => profile.inverse_rules.get(name).is_some_and(|parents| parents.iter().any(|parent| parent == node.kind())),
		RuleExpr::Regex(pattern) => Regex::new(pattern).is_ok_and(|re| re.is_match(node.kind())),
		RuleExpr::Exclude { include, exclude } => matches_rule_expr(include, node, profile) && !matches_rule_expr(exclude, node, profile),
		RuleExpr::All => true,
	}
}
