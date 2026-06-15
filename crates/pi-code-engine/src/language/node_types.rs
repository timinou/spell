use std::collections::HashMap;

use serde::Deserialize;

use super::{GeneratedGrammar, ProductionRule};
use crate::{CodeEngineError, Result};

#[derive(Deserialize)]
struct NodeType {
	r#type:   String,
	named:    bool,
	#[serde(default)]
	fields:   HashMap<String, FieldInfo>,
	#[serde(default)]
	children: Option<ChildrenInfo>,
	#[serde(default)]
	subtypes: Option<Vec<SubType>>,
}

#[derive(Deserialize)]
struct FieldInfo {
	#[allow(dead_code, reason = "required for node-types.json deserialization")]
	multiple: bool,
	#[allow(dead_code, reason = "required for node-types.json deserialization")]
	required: bool,
	types:    Vec<SubType>,
}

#[derive(Deserialize)]
struct ChildrenInfo {
	#[allow(dead_code, reason = "required for node-types.json deserialization")]
	multiple: bool,
	#[allow(dead_code, reason = "required for node-types.json deserialization")]
	required: bool,
	types:    Vec<SubType>,
}

#[derive(Deserialize)]
struct SubType {
	r#type: String,
	named:  bool,
}

/// Build Spell's runtime grammar metadata from a tree-sitter
/// `node-types.json` payload.
///
/// This is the runtime twin of `build.rs`'s generated-grammar transform: it
/// produces the production/inverse/supertype tables that structural edit and
/// navigation need, without requiring a Rust rebuild for newly registered
/// language profiles.
pub fn grammar_from_node_types(json: &str) -> Result<GeneratedGrammar> {
	let node_types: Vec<NodeType> = serde_json::from_str(json)
		.map_err(|error| CodeEngineError::Profile(format!("invalid node-types.json: {error}")))?;
	Ok(grammar_from_node_type_defs(&node_types))
}

fn grammar_from_node_type_defs(node_types: &[NodeType]) -> GeneratedGrammar {
	let mut production_rules = HashMap::new();
	let mut inverse_rules: HashMap<String, Vec<String>> = HashMap::new();
	let mut all_types = Vec::new();
	let mut supertypes = Vec::new();

	for node_type in node_types {
		if !node_type.named {
			continue;
		}

		all_types.push(node_type.r#type.clone());

		if let Some(subtypes) = &node_type.subtypes {
			supertypes.push(node_type.r#type.clone());
			for subtype in subtypes {
				if subtype.named {
					inverse_rules
						.entry(subtype.r#type.clone())
						.or_default()
						.push(node_type.r#type.clone());
				}
			}
			continue;
		}

		if node_type.fields.is_empty() && node_type.children.is_none() {
			continue;
		}

		let mut rule = ProductionRule::default();

		for (field_name, field_info) in &node_type.fields {
			let child_types: Vec<String> = field_info
				.types
				.iter()
				.filter(|candidate| candidate.named)
				.map(|candidate| candidate.r#type.clone())
				.collect();
			if child_types.is_empty() {
				continue;
			}
			rule.fields.insert(field_name.clone(), child_types.clone());
			for child_type in child_types {
				inverse_rules
					.entry(child_type)
					.or_default()
					.push(node_type.r#type.clone());
			}
		}

		if let Some(children) = &node_type.children {
			rule.unnamed_children = children
				.types
				.iter()
				.filter(|candidate| candidate.named)
				.map(|candidate| candidate.r#type.clone())
				.collect();
		}

		production_rules.insert(node_type.r#type.clone(), rule);
	}

	for parents in inverse_rules.values_mut() {
		parents.sort();
		parents.dedup();
	}

	GeneratedGrammar { production_rules, inverse_rules, all_types, supertypes }
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::language::generated;

	#[test]
	fn runtime_node_types_match_generated_org_grammar() {
		let runtime =
			grammar_from_node_types(include_str!("../../../tree-sitter-org/src/node-types.json"))
				.expect("org node-types.json should parse");
		let generated = generated::org::grammar();

		assert_eq!(runtime.all_types, generated.all_types);
		assert_eq!(runtime.supertypes, generated.supertypes);
		assert_eq!(runtime.production_rules, generated.production_rules);
		assert_eq!(runtime.inverse_rules, generated.inverse_rules);
	}
}
