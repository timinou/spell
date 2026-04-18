use std::fmt::Write;

use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	language::{
		BodyExtractor, ClassBodyExtractor, DeclarationOutlineEnrichment, DeclarationPattern,
		LanguageProfile, NameExtractor, PresenceExtractor, TextListExtractor,
	},
	resolve::resolve_symbol,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnrichFlags {
	pub signature: bool,
	pub metrics:   bool,
	pub doc:       bool,
	pub graph:     bool,
}

impl EnrichFlags {
	pub const L0_ONLY: Self =
		Self { signature: false, metrics: false, doc: false, graph: false };

	pub fn from_tokens<I, S>(tokens: I) -> Self
	where
		I: IntoIterator<Item = S>,
		S: AsRef<str>,
	{
		let mut flags = Self::default();
		for token in tokens {
			match token.as_ref() {
				"signature" => flags.signature = true,
				"metrics" => flags.metrics = true,
				"doc" => flags.doc = true,
				"graph" => flags.graph = true,
				_ => {},
			}
		}
		flags
	}
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParamInfo {
	pub name:     String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub ty:       Option<String>,
	#[serde(skip_serializing_if = "std::ops::Not::not", default)]
	pub optional: bool,
	#[serde(skip_serializing_if = "std::ops::Not::not", default)]
	pub rest:     bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReachSummary {
	pub count:  u32,
	pub capped: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClusterRef {
	pub id:   usize,
	pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutlineEntry {
	pub name:        String,
	pub kind:        String,
	pub line:        u32,
	pub end_line:    u32,
	pub column:      u32,
	pub exported:    bool,
	pub signature:   String,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub children:    Vec<Self>,
	#[serde(skip)]
	pub deduplicate: bool,

	#[serde(skip_serializing_if = "is_zero_u32", default)]
	pub loc:        u32,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub modifiers:  Vec<String>,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub decorators: Vec<String>,
	#[serde(skip_serializing_if = "std::ops::Not::not", default)]
	pub deprecated: bool,

	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub params:      Vec<ParamInfo>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub return_type: Option<String>,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub generics:    Vec<String>,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub throws:      Vec<String>,

	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub statements:       Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub branch_points:    Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub nesting_depth:    Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub call_sites:       Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub has_side_effects: Option<bool>,

	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub doc_summary: Option<String>,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub doc_tags:    Vec<String>,

	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub refs_in:        Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub refs_out:       Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub callers:        Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub callees:        Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub imported_by:    Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub exported_reach: Option<ReachSummary>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub cluster:        Option<ClusterRef>,
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub dead:           Option<bool>,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub inherits:       Vec<String>,
}

#[allow(
	clippy::trivially_copy_pass_by_ref,
	clippy::missing_const_for_fn,
	reason = "serde skip_serializing_if requires fn(&T)"
)]
fn is_zero_u32(value: &u32) -> bool {
	*value == 0
}

pub fn outline(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	enrich: EnrichFlags,
) -> Vec<OutlineEntry> {
	let source = buffer.source();
	let root = buffer.tree().root_node();
	let mut cursor = root.walk();
	let mut entries = root
		.named_children(&mut cursor)
		.filter_map(|node| entry_for_node(&source, profile, node, enrich))
		.collect::<Vec<_>>();
	deduplicate_entries(&mut entries);
	entries
}

fn entry_for_node(
	source: &str,
	profile: &LanguageProfile,
	node: Node<'_>,
	enrich: EnrichFlags,
) -> Option<OutlineEntry> {
	if node.kind() == "export_statement" {
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if let Some(entry) = entry_for_node(source, profile, child, enrich) {
				return Some(OutlineEntry { exported: true, ..entry });
			}
		}
		return None;
	}

	let Some(decl) = declaration_for(profile, node, source) else {
		return sole_named_child(node)
			.and_then(|child| entry_for_node(source, profile, child, enrich));
	};
	let name = declaration_name(source, node, decl)?;
	let signature = semantic_signature(&name, source, node, decl);
	let start = node.start_position();
	let end = node.end_position();
	let children = class_children(source, profile, node, enrich);
	let modifiers = extract_l0_modifiers(source, node, decl);
	let decorators = extract_l0_decorators(source, node, decl);
	let deprecated = extract_l0_deprecated(source, node, decl, &modifiers, &decorators);
	let (params, return_type, generics, throws) = if enrich.signature {
		(
			extract_l1_params(source, node, decl),
			extract_l1_return_type(source, node, decl),
			extract_l1_generics(source, node, decl),
			extract_l1_throws(source, node, decl),
		)
	} else {
		(Vec::new(), None, Vec::new(), Vec::new())
	};
	let (statements, branch_points, nesting_depth, call_sites, has_side_effects) = if enrich.metrics
	{
		extract_l2_metrics(source, node, decl)
	} else {
		(None, None, None, None, None)
	};
	let (doc_summary, doc_tags) = if enrich.doc {
		extract_l3_doc(source, node, decl)
	} else {
		(None, Vec::new())
	};
	Some(OutlineEntry {
		name,
		kind: decl.kind.clone(),
		line: (start.row + 1) as u32,
		end_line: (end.row + 1) as u32,
		column: start.column as u32,
		exported: is_exported(node, decl),
		signature,
		children,
		deduplicate: should_deduplicate_entry(profile, decl),
		loc: (end.row.saturating_sub(start.row) + 1) as u32,
		modifiers,
		decorators,
		deprecated,
		params,
		return_type,
		generics,
		throws,
		statements,
		branch_points,
		nesting_depth,
		call_sites,
		has_side_effects,
		doc_summary,
		doc_tags,
		refs_in: None,
		refs_out: None,
		callers: None,
		callees: None,
		imported_by: None,
		exported_reach: None,
		cluster: None,
		dead: None,
		inherits: Vec::new(),
	})
}

fn sole_named_child(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	let mut children = node.named_children(&mut cursor);
	let child = children.next()?;
	(children.next().is_none()).then_some(child)
}

fn class_children(
	source: &str,
	profile: &LanguageProfile,
	node: Node<'_>,
	enrich: EnrichFlags,
) -> Vec<OutlineEntry> {
	let mut children = class_member_nodes(profile, node, source)
		.into_iter()
		.filter_map(|child| entry_for_node(source, profile, child, enrich))
		.collect::<Vec<_>>();
	deduplicate_entries(&mut children);
	children
}

fn extract_l0_modifiers(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Vec<String> {
	let configured = extract_text_lists(source, node, &decl.outline_enrichment.modifiers);
	if !configured.is_empty() {
		return configured;
	}
	let mut modifiers = Vec::new();
	if let Some(parent) = node.parent()
		&& parent.kind() == "export_statement"
		&& let Some(parent_text) = text(source, parent)
	{
		for keyword in ["export", "default"] {
			if contains_word(parent_text, keyword) {
				modifiers.push(keyword.to_string());
			}
		}
	}
	let header = signature_text(source, node, decl);
	for keyword in [
		"async",
		"static",
		"readonly",
		"abstract",
		"override",
		"private",
		"protected",
		"public",
		"pub",
		"unsafe",
		"const",
		"extern",
	] {
		if contains_word(&header, keyword) {
			modifiers.push(keyword.to_string());
		}
	}
	dedupe_texts(modifiers)
}

fn extract_l0_decorators(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Vec<String> {
	let configured = extract_text_lists(source, node, &decl.outline_enrichment.decorators);
	if !configured.is_empty() {
		return configured;
	}
	let mut decorators = Vec::new();
	let mut cursor = node.walk();
	decorators.extend(
		node
			.named_children(&mut cursor)
			.filter(|child| matches!(child.kind(), "decorator" | "attribute_item"))
			.filter_map(|child| text(source, child).map(|value| value.trim().to_string()))
			.filter(|value| !value.is_empty()),
	);
	let mut sibling = node.prev_named_sibling();
	let mut leading = Vec::new();
	while let Some(current) = sibling {
		if !matches!(current.kind(), "decorator" | "attribute_item") {
			break;
		}
		if let Some(value) = text(source, current) {
			leading.push(value.trim().to_string());
		}
		sibling = current.prev_named_sibling();
	}
	leading.reverse();
	decorators.splice(0..0, leading);
	dedupe_texts(decorators)
}

fn extract_l0_deprecated(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
	modifiers: &[String],
	decorators: &[String],
) -> bool {
	if !decl.outline_enrichment.deprecated.is_empty() {
		return decl
			.outline_enrichment
			.deprecated
			.iter()
			.any(|extractor| extract_presence(source, node, extractor));
	}
	modifiers
		.iter()
		.any(|value| contains_word(value, "deprecated"))
		|| decorators
			.iter()
			.any(|value| contains_word(value, "deprecated"))
		|| text(source, node.parent().unwrap_or(node))
			.is_some_and(|value| contains_word(value, "deprecated"))
}

fn extract_text_lists(
	source: &str,
	node: Node<'_>,
	extractors: &[TextListExtractor],
) -> Vec<String> {
	let mut values = Vec::new();
	for extractor in extractors {
		match extractor {
			TextListExtractor::Field { name } => {
				if let Some(child) = node.child_by_field_name(name)
					&& let Some(value) = text(source, child)
				{
					values.push(value.trim().to_string());
				}
			},
			TextListExtractor::FieldChildren { field, child_types } => {
				if let Some(parent) = node.child_by_field_name(field) {
					let mut cursor = parent.walk();
					for child in parent.named_children(&mut cursor) {
						if !child_types.is_empty() && !child_types.iter().any(|kind| kind == child.kind())
						{
							continue;
						}
						if let Some(value) = text(source, child) {
							values.push(value.trim().to_string());
						}
					}
				}
			},
			TextListExtractor::NamedChildren { child_types } => {
				let mut cursor = node.walk();
				for child in node.named_children(&mut cursor) {
					if !child_types.is_empty() && !child_types.iter().any(|kind| kind == child.kind()) {
						continue;
					}
					if let Some(value) = text(source, child) {
						values.push(value.trim().to_string());
					}
				}
			},
			TextListExtractor::Descendants { node_types } => {
				collect_named_descendant_texts(source, node, node_types, &mut values);
			},
		}
	}
	dedupe_texts(values)
}

fn extract_presence(source: &str, node: Node<'_>, extractor: &PresenceExtractor) -> bool {
	match extractor {
		PresenceExtractor::Field { name } => node.child_by_field_name(name).is_some(),
		PresenceExtractor::ChildKind { child_type } => {
			let mut cursor = node.walk();
			node
				.named_children(&mut cursor)
				.any(|child| child.kind() == child_type)
		},
		PresenceExtractor::NodeKind { node_types } => {
			node_types.iter().any(|kind| kind == node.kind())
		},
		PresenceExtractor::TextEquals { extractor, value } => {
			name_resolution(source, node, extractor).is_some_and(|resolved| resolved.text == *value)
		},
	}
}

fn collect_named_descendant_texts(
	source: &str,
	node: Node<'_>,
	node_types: &[String],
	out: &mut Vec<String>,
) {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if (node_types.is_empty() || node_types.iter().any(|kind| kind == child.kind()))
			&& let Some(value) = text(source, child)
		{
			out.push(value.trim().to_string());
		}
		collect_named_descendant_texts(source, child, node_types, out);
	}
}

fn contains_word(text: &str, word: &str) -> bool {
	text.match_indices(word).any(|(idx, _)| {
		let prev = text[..idx].chars().next_back();
		let next = text[idx + word.len()..].chars().next();
		is_word_boundary(prev) && is_word_boundary(next)
	})
}

fn is_word_boundary(ch: Option<char>) -> bool {
	ch.is_none_or(|value| !value.is_alphanumeric() && value != '_')
}

fn dedupe_texts(values: Vec<String>) -> Vec<String> {
	let mut seen = std::collections::BTreeSet::new();
	values
		.into_iter()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
		.filter(|value| seen.insert(value.clone()))
		.collect()
}
fn extract_l1_params(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Vec<ParamInfo> {
	for extractor in &decl.outline_enrichment.signature.parameters {
		if let Some(params_node) = node.child_by_field_name(&extractor.field) {
			let params = extract_params_from_node(source, params_node, Some(extractor));
			if !params.is_empty() {
				return params;
			}
		}
	}
	node
		.child_by_field_name("parameters")
		.map(|params_node| extract_params_from_node(source, params_node, None))
		.unwrap_or_default()
}

fn extract_params_from_node(
	source: &str,
	params_node: Node<'_>,
	extractor: Option<&crate::language::ParameterListExtractor>,
) -> Vec<ParamInfo> {
	let mut cursor = params_node.walk();
	params_node
		.named_children(&mut cursor)
		.filter(|child| {
			extractor.is_none_or(|config| {
				config.item_types.is_empty()
					|| config.item_types.iter().any(|kind| kind == child.kind())
			})
		})
		.filter_map(|param| build_param_info(source, param, extractor))
		.collect()
}

fn build_param_info(
	source: &str,
	param: Node<'_>,
	extractor: Option<&crate::language::ParameterListExtractor>,
) -> Option<ParamInfo> {
	let raw = text(source, param)?.trim();
	let name = extractor
		.and_then(|config| config.name.as_ref())
		.and_then(|name_extractor| name_resolution(source, param, name_extractor))
		.map(|resolved| resolved.text)
		.or_else(|| fallback_param_name(source, param))?;
	let ty = extractor
		.and_then(|config| config.ty.as_ref())
		.and_then(|type_extractor| name_resolution(source, param, type_extractor))
		.map(|resolved| normalize_type_text(&resolved.text))
		.or_else(|| fallback_param_type(source, param));
	let optional = extractor.is_some_and(|config| {
		config
			.optional_when_node_types
			.iter()
			.any(|kind| kind == param.kind())
	}) || raw
		.split(':')
		.next()
		.is_some_and(|segment| segment.contains('?'));
	let rest = extractor.is_some_and(|config| {
		config
			.rest_when_node_types
			.iter()
			.any(|kind| kind == param.kind())
	}) || raw.trim_start().starts_with("...");
	Some(ParamInfo { name, ty, optional, rest })
}

fn fallback_param_name(source: &str, param: Node<'_>) -> Option<String> {
	for field in ["pattern", "name", "parameter", "left"] {
		if let Some(child) = param.child_by_field_name(field)
			&& let Some(value) = text(source, child)
		{
			let normalized = normalize_param_name(value);
			if !normalized.is_empty() {
				return Some(normalized);
			}
		}
	}
	if param.kind() == "self_parameter" {
		return Some("self".into());
	}
	text(source, param)
		.map(normalize_param_name)
		.filter(|value| !value.is_empty())
}

fn fallback_param_type(source: &str, param: Node<'_>) -> Option<String> {
	for field in ["type", "type_annotation"] {
		if let Some(child) = param.child_by_field_name(field)
			&& let Some(value) = text(source, child)
		{
			let normalized = normalize_type_text(value);
			if !normalized.is_empty() {
				return Some(normalized);
			}
		}
	}
	text(source, param)
		.and_then(|value| value.split_once(':').map(|(_, ty)| normalize_type_text(ty)))
}

fn extract_l1_return_type(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<String> {
	if let Some(extractor) = decl.outline_enrichment.signature.return_type.as_ref()
		&& let Some(resolved) = name_resolution(source, node, extractor)
	{
		let normalized = normalize_type_text(&resolved.text);
		if !normalized.is_empty() {
			return Some(normalized);
		}
	}
	node
		.child_by_field_name("return_type")
		.and_then(|child| text(source, child))
		.map(normalize_type_text)
		.filter(|value| !value.is_empty())
}

fn extract_l1_generics(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Vec<String> {
	let configured = extract_text_lists(source, node, &decl.outline_enrichment.signature.generics);
	if !configured.is_empty() {
		return configured;
	}
	let Some(type_params) = node.child_by_field_name("type_parameters") else {
		return Vec::new();
	};
	text(source, type_params)
		.map(parse_generic_list)
		.unwrap_or_default()
}

fn extract_l1_throws(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Vec<String> {
	let configured = extract_text_lists(source, node, &decl.outline_enrichment.signature.throws);
	if !configured.is_empty() {
		return configured;
	}
	let header = signature_text(source, node, decl);
	header
		.split_once("throws ")
		.map(|(_, rest)| {
			rest
				.split(',')
				.map(normalize_type_text)
				.filter(|value| !value.is_empty())
				.collect()
		})
		.unwrap_or_default()
}

fn parse_generic_list(text: &str) -> Vec<String> {
	text
		.trim()
		.trim_start_matches('<')
		.trim_end_matches('>')
		.split(',')
		.map(normalize_type_text)
		.filter(|value| !value.is_empty())
		.collect()
}

fn normalize_param_name(raw: &str) -> String {
	raw.trim()
		.trim_start_matches("...")
		.trim_start_matches("mut ")
		.split(':')
		.next()
		.unwrap_or(raw)
		.split('=')
		.next()
		.unwrap_or(raw)
		.trim_end_matches('?')
		.trim()
		.to_string()
}

fn normalize_type_text(raw: &str) -> String {
	raw.trim()
		.trim_start_matches(':')
		.trim_start_matches("->")
		.trim()
		.to_string()
}
#[allow(clippy::type_complexity, reason = "returns a flattened L2 metrics tuple")]
fn extract_l2_metrics(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> (Option<u32>, Option<u32>, Option<u32>, Option<u32>, Option<bool>) {
	let Some(body) = declaration_body_node(node, decl) else {
		return (None, None, None, None, None);
	};
	let mut stats = MetricStats::default();
	collect_metric_stats(source, body, 0, &mut stats);
	(
		Some(stats.statements),
		Some(stats.branch_points),
		Some(stats.nesting_depth),
		Some(stats.call_sites),
		Some(stats.has_side_effects),
	)
}

#[derive(Default)]
struct MetricStats {
	statements:       u32,
	branch_points:    u32,
	nesting_depth:    u32,
	call_sites:       u32,
	has_side_effects: bool,
}

fn collect_metric_stats(source: &str, node: Node<'_>, depth: u32, stats: &mut MetricStats) {
	let kind = node.kind();
	if is_statement_like(kind) {
		stats.statements += 1;
	}
	let branch = is_branch_point(kind);
	let next_depth = if branch {
		stats.branch_points += 1;
		(depth + 1).max(stats.nesting_depth)
	} else {
		depth
	};
	stats.nesting_depth = stats.nesting_depth.max(next_depth);
	if is_call_like(kind) {
		stats.call_sites += 1;
	}
	if is_side_effecting(kind, source, node) {
		stats.has_side_effects = true;
	}
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		collect_metric_stats(source, child, next_depth, stats);
	}
}

fn declaration_body_node<'a>(node: Node<'a>, decl: &DeclarationPattern) -> Option<Node<'a>> {
	match &decl.body {
		BodyExtractor::None => None,
		BodyExtractor::Field { name } => child_by_field_or_kind(node, name),
		BodyExtractor::AfterChild { child_type } => {
			find_named_child(node, child_type).and_then(|child| {
				let mut sibling = child.next_named_sibling();
				while let Some(current) = sibling {
					if current.start_byte() >= child.end_byte() {
						return Some(current);
					}
					sibling = current.next_named_sibling();
				}
				None
			})
		},
	}
}

fn is_statement_like(kind: &str) -> bool {
	kind.ends_with("_statement")
		|| kind.ends_with("_declaration")
		|| matches!(kind, "statement" | "parameter" | "self_parameter" | "assignment")
}

fn is_branch_point(kind: &str) -> bool {
	matches!(
		kind,
		"if_statement"
			| "for_statement"
			| "for_in_statement"
			| "while_statement"
			| "loop_expression"
			| "match_expression"
			| "switch_statement"
			| "conditional_expression"
			| "case_clause"
			| "catch_clause"
	)
}

fn is_call_like(kind: &str) -> bool {
	matches!(kind, "call_expression" | "call" | "function_call_expression" | "macro_invocation")
}

fn is_side_effecting(kind: &str, source: &str, node: Node<'_>) -> bool {
	if is_call_like(kind) {
		return true;
	}
	if matches!(
		kind,
		"assignment_expression"
			| "augmented_assignment_expression"
			| "assignment"
			| "update_expression"
			| "return_statement"
			| "throw_statement"
			| "yield_expression"
			| "break_statement"
			| "continue_statement"
	) {
		return true;
	}
	text(source, node).is_some_and(|value| value.contains('=') && !value.contains("=="))
}
fn extract_l3_doc(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> (Option<String>, Vec<String>) {
	let anchor = node
		.parent()
		.filter(|parent| parent.kind() == "export_statement")
		.unwrap_or(node);
	let lines = leading_comment_block(source, anchor.start_position().row);
	if lines.is_empty() {
		return (None, Vec::new());
	}
	let tag_prefixes = if decl.outline_enrichment.doc.tag_prefixes.is_empty() {
		vec!["@".to_string()]
	} else {
		decl.outline_enrichment.doc.tag_prefixes.clone()
	};
	let cleaned = lines
		.into_iter()
		.map(|line| clean_doc_line(&line))
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>();
	let summary = cleaned
		.iter()
		.find(|line| !tag_prefixes.iter().any(|prefix| line.starts_with(prefix)))
		.cloned();
	let tags = cleaned
		.iter()
		.filter_map(|line| parse_doc_tag(line, &tag_prefixes))
		.collect::<Vec<_>>();
	(summary, tags)
}

fn leading_comment_block(source: &str, start_row: usize) -> Vec<String> {
	let lines = source.lines().collect::<Vec<_>>();
	if start_row == 0 || start_row > lines.len() {
		return Vec::new();
	}
	let mut row = start_row.saturating_sub(1);
	let mut collected = Vec::new();
	while let Some(line) = lines.get(row) {
		let trimmed = line.trim();
		if trimmed.is_empty() || !is_commentish_line(trimmed) {
			break;
		}
		collected.push((*line).to_string());
		if row == 0 {
			break;
		}
		row -= 1;
	}
	collected.reverse();
	collected
}

fn is_commentish_line(line: &str) -> bool {
	line.starts_with("///")
		|| line.starts_with("//!")
		|| line.starts_with("//")
		|| line.starts_with("/**")
		|| line.starts_with("/*")
		|| line.starts_with('*')
		|| line.starts_with("*/")
}

fn clean_doc_line(line: &str) -> String {
	line
		.trim()
		.trim_start_matches("/**")
		.trim_start_matches("/*")
		.trim_start_matches("///")
		.trim_start_matches("//!")
		.trim_start_matches("//")
		.trim_start_matches('*')
		.trim_start_matches("*/")
		.trim()
		.to_string()
}

fn parse_doc_tag(line: &str, tag_prefixes: &[String]) -> Option<String> {
	for prefix in tag_prefixes {
		if let Some(rest) = line.strip_prefix(prefix) {
			let tag = rest.split_whitespace().next()?.trim();
			if !tag.is_empty() {
				return Some(tag.to_string());
			}
		}
	}
	None
}
pub(crate) fn declaration_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
	source: &str,
) -> Option<&'a DeclarationPattern> {
	profile.declarations.iter().find(|decl| {
		if !decl.node_types.iter().any(|kind| kind == node.kind()) {
			return false;
		}
		if let Some(filter_names) = &decl.filter_names {
			let name_text = match &decl.name {
				NameExtractor::Field { name } => node
					.child_by_field_name(name)
					.and_then(|n| source.get(n.start_byte()..n.end_byte())),
				_ => None,
			};
			return name_text.is_some_and(|t| filter_names.iter().any(|f| f == t));
		}
		true
	})
}

pub fn declaration_name(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Option<String> {
	declaration_name_resolution(source, node, decl).map(|resolution| resolution.text)
}

#[derive(Debug, Clone)]
pub(crate) struct NameResolution {
	pub text: String,
}

pub(crate) fn declaration_name_resolution(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<NameResolution> {
	if decl.name_from_arg {
		let args = child_by_field_or_kind(node, "arguments")?;
		let mut cursor = args.walk();
		let first = args.named_children(&mut cursor).next()?;
		if let Some(target) = first.child_by_field_name("target") {
			return resolution_from_node(source, target, None, false);
		}
		return resolution_from_node(source, first, None, false);
	}

	match &decl.name {
		NameExtractor::Field { name } => {
			if let Some(name_node) = node.child_by_field_name(name) {
				let name_node = if decl.kind == "let" && node.kind() == "let" && name == "pattern" {
					if name_node.kind() == "call" {
						name_node.child_by_field_name("callee").unwrap_or_else(|| {
							let mut cursor = name_node.walk();
							name_node
								.named_children(&mut cursor)
								.next()
								.unwrap_or(name_node)
						})
					} else {
						name_node.child_by_field_name("name").unwrap_or(name_node)
					}
				} else {
					name_node.child_by_field_name("name").unwrap_or(name_node)
				};
				return resolution_from_node(source, name_node, None, false);
			}

			find_named_descendant(node, "variable_declarator")
				.and_then(|declarator| declarator.child_by_field_name("name"))
				.and_then(|name_node| resolution_from_node(source, name_node, None, false))
		},
		NameExtractor::ChildField { child_type, field } => find_named_child(node, child_type)
			.and_then(|child| child.child_by_field_name(field))
			.and_then(|name_node| resolution_from_node(source, name_node, None, false)),
		NameExtractor::ChildText { child_type } => find_named_child(node, child_type)
			.or_else(|| find_named_descendant(node, child_type))
			.and_then(|child| resolution_from_node(source, child, None, false)),
		NameExtractor::Literal { name } => Some(NameResolution { text: name.clone() }),
		NameExtractor::AttributeValue { within_type, attr_name, prefix, take_first_token } => {
			attribute_value_resolution(
				source,
				node,
				within_type.as_deref(),
				attr_name,
				prefix.as_deref(),
				*take_first_token,
			)
		},
		NameExtractor::Attributed { base, enrichments } => {
			let mut base_resolution = name_resolution(source, node, base)?;
			for enrichment in enrichments {
				if let Some(extra) = attribute_value_resolution(
					source,
					node,
					enrichment.within_type.as_deref(),
					&enrichment.attr_name,
					Some(enrichment.prefix.as_str()),
					enrichment.take_first_token,
				) {
					base_resolution.text.push_str(&extra.text);
				}
			}
			Some(base_resolution)
		},
	}
}

fn name_resolution(
	source: &str,
	node: Node<'_>,
	extractor: &NameExtractor,
) -> Option<NameResolution> {
	let decl = DeclarationPattern {
		node_types:         Vec::new(),
		name:               extractor.clone(),
		kind:               String::new(),
		body:               BodyExtractor::None,
		visibility:         None,
		filter_names:       None,
		name_from_arg:      false,
		outline_enrichment: DeclarationOutlineEnrichment::default(),
	};
	declaration_name_resolution(source, node, &decl)
}

fn resolution_from_node(
	source: &str,
	node: Node<'_>,
	prefix: Option<&str>,
	take_first_token: bool,
) -> Option<NameResolution> {
	let raw = text(source, node)?.trim();
	let token = if take_first_token {
		raw.split_whitespace().next()?
	} else {
		raw
	};
	if token.is_empty() {
		return None;
	}
	Some(NameResolution {
		text: prefix.map_or_else(|| token.to_string(), |prefix| format!("{prefix}{token}")),
	})
}

fn attribute_value_resolution(
	source: &str,
	node: Node<'_>,
	within_type: Option<&str>,
	attr_name: &str,
	prefix: Option<&str>,
	take_first_token: bool,
) -> Option<NameResolution> {
	let scope = within_type
		.and_then(|kind| find_named_child(node, kind).or_else(|| find_named_descendant(node, kind)))
		.unwrap_or(node);
	let attribute = named_children(scope)
		.into_iter()
		.filter(|child| child.kind() == "attribute")
		.find(|attribute| attribute_name_matches(source, *attribute, attr_name))?;
	let value_node = find_named_child(attribute, "quoted_attribute_value")
		.or_else(|| find_named_child(attribute, "attribute_value"))?;
	let raw = text(source, value_node)?
		.trim()
		.trim_matches('"')
		.trim_matches('\'')
		.trim_matches('`');
	let token = if take_first_token {
		raw.split_whitespace().next()?
	} else {
		raw
	};
	if token.is_empty() {
		return None;
	}
	Some(NameResolution {
		text: prefix.map_or_else(|| token.to_string(), |prefix| format!("{prefix}{token}")),
	})
}

fn attribute_name_matches(source: &str, attribute: Node<'_>, attr_name: &str) -> bool {
	find_named_child(attribute, "attribute_name")
		.and_then(|name_node| text(source, name_node))
		.is_some_and(|value| value.trim() == attr_name)
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
	let mut cursor = node.walk();
	node.named_children(&mut cursor).collect()
}

/// Try `child_by_field_name(name)` first; fall back to first named child
/// with `kind() == name`.  Needed for tree-sitter grammars that use
/// positional (unnamed) children (e.g. `do_block` and `arguments` in Elixir).
pub(crate) fn child_by_field_or_kind<'a>(node: Node<'a>, name: &str) -> Option<Node<'a>> {
	if let Some(child) = node.child_by_field_name(name) {
		return Some(child);
	}
	find_named_child(node, name)
}
fn find_named_child<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find(|child| child.kind() == kind)
}

pub(crate) fn declaration_body_range(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<(usize, usize)> {
	match &decl.body {
		BodyExtractor::None => None,
		BodyExtractor::Field { name } => {
			child_by_field_or_kind(node, name).map(|body| (body.start_byte(), body.end_byte()))
		},
		BodyExtractor::AfterChild { child_type } => find_named_child(node, child_type).map(|child| {
			let mut start = child.end_byte();
			if let Some(rest) = source.get(start..) {
				if rest.starts_with("\r\n") {
					start += 2;
				} else if rest.starts_with('\n') {
					start += 1;
				}
			}
			(start, node.end_byte())
		}),
	}
}

pub(crate) fn class_member_nodes<'a>(
	profile: &LanguageProfile,
	node: Node<'a>,
	source: &str,
) -> Vec<Node<'a>> {
	let Some(class_like) = profile.class_like.iter().find(|cl| {
		if cl.node_type != node.kind() {
			return false;
		}
		// Apply filter_field / filter_names when set (e.g. Elixir defmodule).
		if let (Some(filter_field), Some(filter_names)) = (&cl.filter_field, &cl.filter_names) {
			let field_text = node
				.child_by_field_name(filter_field)
				.and_then(|n| source.get(n.start_byte()..n.end_byte()));
			return field_text.is_some_and(|t| filter_names.iter().any(|f| f == t));
		}
		true
	}) else {
		return Vec::new();
	};

	match &class_like.body {
		ClassBodyExtractor::Field { name } => {
			let Some(body) = child_by_field_or_kind(node, name) else {
				return Vec::new();
			};
			let mut cursor = body.walk();
			body
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
		ClassBodyExtractor::Direct => {
			let mut cursor = node.walk();
			node
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
	}
}

fn find_named_descendant<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if child.kind() == kind {
			return Some(child);
		}
		if let Some(found) = find_named_descendant(child, kind) {
			return Some(found);
		}
	}
	None
}

fn semantic_signature(
	name: &str,
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> String {
	if matches!(
		decl.kind.as_str(),
		"element" | "style" | "script" | "rule" | "at-rule" | "keyframes" | "property"
	) || should_deduplicate_entry_for_kind(decl.kind.as_str())
	{
		return format!("{name} ({})", decl.kind);
	}
	signature_text(source, node, decl)
}

fn signature_text(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> String {
	let end_byte = declaration_body_range(source, node, decl)
		.map_or_else(|| node.end_byte(), |(start_byte, _)| start_byte);
	let header = source
		.get(node.start_byte()..end_byte)
		.unwrap_or("")
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join(" ");
	truncate(&header, 200)
}

fn should_deduplicate_entry(profile: &LanguageProfile, decl: &DeclarationPattern) -> bool {
	profile.id.as_str() == "html" && should_deduplicate_entry_for_kind(decl.kind.as_str())
}

fn should_deduplicate_entry_for_kind(kind: &str) -> bool {
	let should_deduplicate = matches!(kind, "element" | "style" | "script");
	should_deduplicate
}
fn deduplicate_entries(entries: &mut [OutlineEntry]) {
	for entry in entries.iter_mut() {
		deduplicate_entries(&mut entry.children);
	}
	let mut totals = std::collections::BTreeMap::<(String, String), usize>::new();
	for entry in entries.iter() {
		if entry.deduplicate {
			*totals
				.entry((entry.kind.clone(), entry.name.clone()))
				.or_default() += 1;
		}
	}
	let mut seen = std::collections::BTreeMap::<(String, String), usize>::new();
	for entry in entries.iter_mut() {
		if !entry.deduplicate {
			continue;
		}
		let key = (entry.kind.clone(), entry.name.clone());
		if totals.get(&key).copied().unwrap_or_default() <= 1 {
			continue;
		}
		let occurrence = seen.entry(key).or_default();
		*occurrence += 1;
		entry.name = format!("{}[{}]", entry.name, occurrence);
		entry.signature = format!("{} ({})", entry.name, entry.kind);
	}
}

fn truncate(text: &str, max_chars: usize) -> String {
	text.chars().take(max_chars).collect()
}

fn text<'a>(source: &'a str, node: Node<'a>) -> Option<&'a str> {
	source.get(node.start_byte()..node.end_byte())
}

fn is_exported(node: Node<'_>, decl: &DeclarationPattern) -> bool {
	node
		.parent()
		.is_some_and(|parent| parent.kind() == "export_statement")
		|| decl
			.visibility
			.as_ref()
			.and_then(|field| node.child_by_field_name(field))
			.is_some()
}

pub fn read(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	resolution: u8,
	offset: Option<u32>,
	limit: Option<u32>,
) -> String {
	let source = buffer.source();
	if profile.id.as_str() == "markdown" && resolution <= 2 {
		return read_markdown(buffer, profile, resolution);
	}
	let enrich = EnrichFlags::L0_ONLY;
	match resolution {
		0 => outline(buffer, profile, enrich)
			.into_iter()
			.map(|entry| format!("{} ({})", entry.name, entry.kind))
			.collect::<Vec<_>>()
			.join("\n"),
		1 => render_outline(&outline(buffer, profile, enrich), false, 0),
		2 => render_outline(&outline(buffer, profile, enrich), true, 0),
		_ => slice_source(&source, offset, limit),
	}
}

fn exact_node_for_range(buffer: &CodeBuffer, start: usize, end: usize) -> Option<Node<'_>> {
	let mut node = buffer
		.tree()
		.root_node()
		.named_descendant_for_byte_range(start, end)
		.or_else(|| {
			buffer
				.tree()
				.root_node()
				.descendant_for_byte_range(start, end)
		})?;
	loop {
		if node.start_byte() == start && node.end_byte() == end {
			return Some(node);
		}
		node = node.parent()?;
	}
}

fn markdown_code_language(source: &str, node: Node<'_>) -> Option<String> {
	let info = find_named_child(node, "info_string")?;
	if let Some(language) = find_named_child(info, "language") {
		return text(source, language).map(str::to_string);
	}
	text(source, info)
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
}

fn markdown_annotation(source: &str, node: Node<'_>, has_children: bool) -> String {
	let mut paragraphs = 0usize;
	let mut code_blocks = 0usize;
	let mut code_languages = Vec::new();
	let mut lists = 0usize;
	let mut tables = 0usize;
	let mut block_quotes = 0usize;
	let mut html_blocks = 0usize;
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		match child.kind() {
			"atx_heading" | "section" | "setext_heading" | "block_continuation" => {},
			"paragraph" => paragraphs += 1,
			"fenced_code_block" => {
				code_blocks += 1;
				if let Some(language) = markdown_code_language(source, child)
					&& !code_languages.iter().any(|existing| existing == &language)
				{
					code_languages.push(language);
				}
			},
			"indented_code_block" => code_blocks += 1,
			"list" => lists += 1,
			"pipe_table" => tables += 1,
			"block_quote" => block_quotes += 1,
			"html_block" => html_blocks += 1,
			_ => {},
		}
	}
	let mut parts = Vec::new();
	if paragraphs > 0 {
		parts.push(format!(
			"{} {}",
			paragraphs,
			if paragraphs == 1 {
				"paragraph"
			} else {
				"paragraphs"
			}
		));
	}
	if code_blocks > 0 {
		let mut label = format!(
			"{} {}",
			code_blocks,
			if code_blocks == 1 {
				"code block"
			} else {
				"code blocks"
			}
		);
		if !code_languages.is_empty() {
			let _ = write!(label, " ({})", code_languages.join(", "));
		}
		parts.push(label);
	}
	if lists > 0 {
		parts.push(format!("{} {}", lists, if lists == 1 { "list" } else { "lists" }));
	}
	if tables > 0 {
		parts.push(format!("{} {}", tables, if tables == 1 { "table" } else { "tables" }));
	}
	if block_quotes > 0 {
		parts.push(format!(
			"{} {}",
			block_quotes,
			if block_quotes == 1 {
				"block quote"
			} else {
				"block quotes"
			}
		));
	}
	if html_blocks > 0 {
		parts.push(format!(
			"{} {}",
			html_blocks,
			if html_blocks == 1 {
				"HTML block"
			} else {
				"HTML blocks"
			}
		));
	}
	if parts.is_empty() {
		return if has_children {
			"(subsections only)".into()
		} else {
			"(empty)".into()
		};
	}
	truncate(&parts.join(", "), 120)
}

fn read_markdown(buffer: &CodeBuffer, profile: &LanguageProfile, resolution: u8) -> String {
	let entries = outline(buffer, profile, EnrichFlags::L0_ONLY);
	match resolution {
		0 => entries
			.into_iter()
			.map(|entry| format!("{} ({})", entry.name, entry.kind))
			.collect::<Vec<_>>()
			.join("\n"),
		1 => render_outline(&entries, true, 0),
		2 => render_markdown_entries(buffer, profile, &entries, 0, None),
		_ => unreachable!(),
	}
}

fn render_markdown_entries(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	entries: &[OutlineEntry],
	indent: usize,
	parent_path: Option<&str>,
) -> String {
	let mut lines = Vec::new();
	for entry in entries {
		let indent_str = "  ".repeat(indent);
		if entry.kind == "frontmatter" {
			let label = match resolve_symbol(buffer, profile, "frontmatter")
				.ok()
				.and_then(|resolved| {
					exact_node_for_range(buffer, resolved.start_byte, resolved.end_byte)
				})
				.map(|node| node.kind().to_string())
				.as_deref()
			{
				Some("minus_metadata") => "frontmatter (yaml)",
				Some("plus_metadata") => "frontmatter (toml)",
				_ => "frontmatter",
			};
			lines.push(format!("{indent_str}{label}"));
			continue;
		}
		let symbol_path = parent_path
			.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
		lines.push(format!(
			"{indent_str}{} (lines {}-{})",
			entry.signature, entry.line, entry.end_line
		));
		if let Ok(resolved) = resolve_symbol(buffer, profile, &symbol_path)
			&& let Some(node) = exact_node_for_range(buffer, resolved.start_byte, resolved.end_byte)
		{
			lines.push(format!(
				"{indent_str}  {}",
				markdown_annotation(&buffer.source(), node, !entry.children.is_empty())
			));
		}
		let hint = if symbol_path.split('.').count() > 2 {
			format!(
				"> code read {{ symbol: \"{symbol_path}\", resolution: 3 }} (use line offset instead)"
			)
		} else {
			format!("> code read {{ symbol: \"{symbol_path}\", resolution: 3 }}")
		};
		lines.push(format!("{indent_str}  {hint}"));
		if !entry.children.is_empty() {
			lines.push(render_markdown_entries(
				buffer,
				profile,
				&entry.children,
				indent + 1,
				Some(&symbol_path),
			));
		}
	}
	lines.join("\n")
}

fn render_outline(entries: &[OutlineEntry], show_children: bool, indent: usize) -> String {
	let mut lines = Vec::new();
	for entry in entries {
		lines.push(format!("{}{}", "  ".repeat(indent), entry.signature));
		if show_children && !entry.children.is_empty() {
			lines.push(render_outline(&entry.children, true, indent + 1));
		}
	}
	lines
		.into_iter()
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join("\n")
}

fn slice_source(source: &str, offset: Option<u32>, limit: Option<u32>) -> String {
	let start = offset.unwrap_or(1).saturating_sub(1) as usize;
	let len = limit.map_or(usize::MAX, |l| l as usize);
	source
		.lines()
		.skip(start)
		.take(len)
		.collect::<Vec<_>>()
		.join("\n")
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use super::*;
	use crate::{
		CodeBuffer,
		language::{LanguageId, LanguageRegistry},
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn fixture_path(name: &str) -> String {
		format!("{}/tests/fixtures/sources/{name}", env!("CARGO_MANIFEST_DIR"))
	}

	fn profile(language: &str) -> LanguageProfile {
		registry()
			.get(&LanguageId::new(language))
			.expect("profile")
			.clone()
	}

	fn buffer(name: &str, language: &str) -> CodeBuffer {
		CodeBuffer::from_str(
			&fs::read_to_string(fixture_path(name)).expect("fixture"),
			LanguageId::new(language),
			registry(),
		)
		.expect("buffer")
	}

	fn inline_buffer(source: &str, language: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new(language), registry()).expect("buffer")
	}

	#[test]
	fn test_outline_typescript() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec![
			"greet", "Greeter"
		]);
		assert_eq!(entries[0].kind, "function");
		assert_eq!(entries[1].kind, "class");
	}

	#[test]
	fn test_outline_typst_code_wrappers() {
		let buffer = buffer("hello.typ", "typst");
		let profile = profile("typst");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["\"theme.typ\"", "title", "heading.where(level: 1)"]
		);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.kind.as_str())
				.collect::<Vec<_>>(),
			vec!["import", "let", "show"]
		);
	}

	#[test]
	fn test_outline_children() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(
			entries[1]
				.children
				.iter()
				.map(|e| e.name.as_str())
				.collect::<Vec<_>>(),
			vec!["constructor", "greet"]
		);
	}

	#[test]
	fn test_read_resolution_0() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("greet (function)"));
		assert!(out.contains("Greeter (class)"));
	}

	#[test]
	fn test_read_resolution_0_typst() {
		let buffer = buffer("hello.typ", "typst");
		let profile = profile("typst");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("\"theme.typ\" (import)"));
		assert!(out.contains("title (let)"));
		assert!(out.contains("heading.where(level: 1) (show)"));
	}

	#[test]
	fn test_outline_html_structure() {
		let buffer = buffer("hello.html", "html");
		let profile = profile("html");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["html#root"]
		);
		let body = &entries[0].children[0];
		assert_eq!(body.name, "body#main");
		assert_eq!(
			body
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["div.card[1]", "div.card[2]", "button#save", "button.btn", "style"]
		);
	}

	#[test]
	fn test_read_resolution_2_html() {
		let buffer = buffer("hello.html", "html");
		let profile = profile("html");
		let out = read(&buffer, &profile, 2, None, None);
		assert!(out.contains("html#root (element)"));
		assert!(out.contains("button#save (element)"));
		assert!(out.contains("div.card[1] (element)"));
		assert!(out.contains("style (style)"));
	}

	#[test]
	fn test_outline_css_structure() {
		let buffer = buffer("hello.css", "css");
		let profile = profile("css");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec![".btn, .link", "@media", "@supports", "fade-in"]
		);
		assert_eq!(
			entries[0]
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["color"]
		);
	}

	#[test]
	fn test_read_resolution_0_css() {
		let buffer = buffer("hello.css", "css");
		let profile = profile("css");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains(".btn, .link (rule)"));
		assert!(out.contains("fade-in (keyframes)"));
		assert!(out.contains("@media (at-rule)"));
	}

	#[test]
	fn test_outline_markdown_sections() {
		let buffer = buffer("hello.md", "markdown");
		let profile = profile("markdown");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["frontmatter", "Introduction", "Installation", "API Reference"]
		);
		assert_eq!(
			entries[2]
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["Prerequisites", "Steps"]
		);
		assert_eq!(
			entries[3]
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["Authentication"]
		);
	}

	#[test]
	fn test_read_resolution_2_markdown() {
		let buffer = buffer("hello.md", "markdown");
		let profile = profile("markdown");
		let out = read(&buffer, &profile, 2, None, None);
		assert!(out.contains("frontmatter (yaml)"), "should render frontmatter label: {out}");
		assert!(
			out.contains("# Installation (lines"),
			"should include section signature + lines: {out}"
		);
		assert!(out.contains("1 paragraph"), "should annotate direct section content: {out}");
		assert!(
			out.contains("1 code block (bash), 1 list"),
			"should include nested code/list annotation: {out}"
		);
		assert!(
			out.contains("Installation.Prerequisites"),
			"should include nested symbol hint: {out}"
		);
		assert!(out.contains("## Steps (lines"), "should render nested headings: {out}");
	}

	#[test]
	fn test_outline_elixir() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		// Only defmodule should appear as top-level
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].name, "MyApp.Greeter");
		assert_eq!(entries[0].kind, "module");
	}

	#[test]
	fn test_outline_elixir_children() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		let children = &entries[0].children;
		assert_eq!(children.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec![
			"start_link",
			"greet",
			"internal_helper",
			"my_macro"
		]);
		assert_eq!(children.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec![
			"def", "def", "defp", "macro"
		]);
	}

	#[test]
	fn test_read_resolution_0_elixir() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("MyApp.Greeter (module)"), "got: {out}");
	}

	#[test]
	fn test_outline_l0_typescript_modifiers_and_loc() {
		let buffer = inline_buffer(
			"export async function greet(name: string) {\n  return name;\n}\n",
			"typescript",
		);
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].loc, 3);
		assert_eq!(entries[0].modifiers, vec!["export", "async"]);
		assert!(entries[0].decorators.is_empty());
		assert!(!entries[0].deprecated);
	}

	#[test]
	fn test_outline_l0_rust_decorators_and_deprecated() {
		let buffer = inline_buffer(
			"#[deprecated(note = \"use new\")]\npub fn old_name() {\n  let value = 1;\n}\n",
			"rust",
		);
		let profile = profile("rust");
		let entries = outline(&buffer, &profile, EnrichFlags::L0_ONLY);
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].loc, 3);
		assert_eq!(entries[0].modifiers, vec!["pub"]);
		assert_eq!(entries[0].decorators.len(), 1);
		assert!(entries[0].decorators[0].contains("deprecated"));
		assert!(entries[0].deprecated);
	}

	#[test]
	fn test_outline_l1_typescript_signature_fields() {
		let buffer = inline_buffer(
			"export async function greet<T>(name?: string, ...rest: number[]): Promise<string> {\n  \
			 return name ?? rest.join(\",\");\n}\n",
			"typescript",
		);
		let profile = profile("typescript");
		let entries =
			outline(&buffer, &profile, EnrichFlags { signature: true, ..EnrichFlags::L0_ONLY });
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].generics, vec!["T"]);
		assert_eq!(entries[0].return_type.as_deref(), Some("Promise<string>"));
		assert_eq!(entries[0].params.len(), 2);
		assert_eq!(entries[0].params[0].name, "name");
		assert_eq!(entries[0].params[0].ty.as_deref(), Some("string"));
		assert!(entries[0].params[0].optional);
		assert!(!entries[0].params[0].rest);
		assert_eq!(entries[0].params[1].name, "rest");
		assert_eq!(entries[0].params[1].ty.as_deref(), Some("number[]"));
		assert!(!entries[0].params[1].optional);
		assert!(entries[0].params[1].rest);
	}

	#[test]
	fn test_outline_l1_rust_signature_fields() {
		let buffer = inline_buffer(
			"pub fn greet<T>(value: usize) -> Result<T, Error> {\n  todo!()\n}\n",
			"rust",
		);
		let profile = profile("rust");
		let entries =
			outline(&buffer, &profile, EnrichFlags { signature: true, ..EnrichFlags::L0_ONLY });
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].generics, vec!["T"]);
		assert_eq!(entries[0].return_type.as_deref(), Some("Result<T, Error>"));
		assert_eq!(entries[0].params.len(), 1);
		assert_eq!(entries[0].params[0].name, "value");
		assert_eq!(entries[0].params[0].ty.as_deref(), Some("usize"));
	}

	#[test]
	fn test_outline_l2_metrics_fields() {
		let buffer = inline_buffer(
			"function score(items: string[]) {\n  let total = 0;\n  for (const item of items) {\n    \
			 if (check(item)) {\n      total += format(item).length;\n    }\n  }\n  return \
			 total;\n}\n",
			"typescript",
		);
		let profile = profile("typescript");
		let entries =
			outline(&buffer, &profile, EnrichFlags { metrics: true, ..EnrichFlags::L0_ONLY });
		assert_eq!(entries.len(), 1);
		assert!(entries[0].statements.is_some_and(|value| value >= 4));
		assert_eq!(entries[0].branch_points, Some(2));
		assert_eq!(entries[0].nesting_depth, Some(2));
		assert_eq!(entries[0].call_sites, Some(2));
		assert_eq!(entries[0].has_side_effects, Some(true));
	}

	#[test]
	fn test_outline_l3_doc_fields() {
		let buffer = inline_buffer(
			"/**\n * Greets a user.\n * @deprecated use greet2\n * @param name human-readable name\n \
			 */\nexport function greet(name: string) {\n  return name;\n}\n",
			"typescript",
		);
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile, EnrichFlags { doc: true, ..EnrichFlags::L0_ONLY });
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].doc_summary.as_deref(), Some("Greets a user."));
		assert_eq!(entries[0].doc_tags, vec!["deprecated", "param"]);
	}

	#[test]
	fn test_read_resolution_3_range() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let out = read(&buffer, &profile, 3, Some(1), Some(1));
		assert!(out.contains("export function greet"));
		assert!(!out.contains("class Greeter"));
	}
}
