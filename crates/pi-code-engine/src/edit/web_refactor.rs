use regex::Regex;
use tree_sitter::Node;

use crate::{
	TextEdit,
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	procedure::{ProcedureExecutionResult, ProcedureProof},
	resolve::ResolvedSymbol,
};

pub fn rename_class_token(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	options: &serde_json::Value,
) -> Result<ProcedureExecutionResult> {
	let old_name = extract_selector_token(&resolved.name, '.').ok_or_else(|| {
		proof_gap(
			"Target does not expose an exact class token",
			"resolved symbol lacks a literal class token",
			"symbol_shape",
			None,
		)
	})?;
	let new_name = normalize_selector_token(required_content(options)?, '.')?;
	rename_selector_like_token(buffer, resolved, old_name, &new_name, SelectorTokenKind::Class)
}

pub fn rename_id_token(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	options: &serde_json::Value,
) -> Result<ProcedureExecutionResult> {
	let old_name = extract_selector_token(&resolved.name, '#').ok_or_else(|| {
		proof_gap(
			"Target does not expose an exact id token",
			"resolved symbol lacks a literal id token",
			"symbol_shape",
			None,
		)
	})?;
	let new_name = normalize_selector_token(required_content(options)?, '#')?;
	rename_selector_like_token(buffer, resolved, old_name, &new_name, SelectorTokenKind::Id)
}

pub fn rename_custom_property(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	options: &serde_json::Value,
) -> Result<ProcedureExecutionResult> {
	if buffer.language().as_str() != "css" {
		return Err(proof_gap(
			"Custom-property rename is only supported in CSS buffers",
			"guest CSS regions are not editable through the host HTML buffer yet",
			"unsupported_host_region",
			None,
		));
	}
	let old_name = normalize_custom_property_name(&resolved.name)?;
	let new_name = normalize_custom_property_name(required_content(options)?)?;

	let source = buffer.source();
	let mut edits = Vec::new();
	walk_named(buffer.tree().root_node(), &mut |node| {
		let Some(text) = node_text(source.as_str(), node) else {
			return Ok(());
		};
		if node.kind() == "property_name" && text == old_name {
			edits.push(replace_node(node, &new_name));
			return Ok(());
		}
		if node.kind() == "plain_value"
			&& text == old_name
			&& is_var_function_arg(node, source.as_str())
		{
			edits.push(replace_node(node, &new_name));
		}
		Ok(())
	})?;

	if edits.is_empty() {
		return Err(proof_gap(
			"No exact custom-property declaration or var() reference matched the target",
			"buffer scan found zero literal custom-property tokens",
			"file_local_exact_scan",
			Some(0),
		));
	}

	Ok(ProcedureExecutionResult {
		proof: Some(ProcedureProof {
			basis:      "file_local_exact_scan".into(),
			reason:     "renamed literal custom-property declaration and var() references in the \
			             current CSS buffer"
				.into(),
			confidence: "high".into(),
			matches:    Some(edits.len()),
		}),
		edits,
	})
}

pub fn delete_resolved_symbol(
	_buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	_options: &serde_json::Value,
) -> Result<ProcedureExecutionResult> {
	Ok(ProcedureExecutionResult {
		edits: vec![TextEdit {
			start_byte:   resolved.start_byte,
			old_end_byte: resolved.end_byte,
			new_text:     String::new(),
		}],
		proof: None,
	})
}

#[derive(Clone, Copy)]
enum SelectorTokenKind {
	Class,
	Id,
}

fn rename_selector_like_token(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	old_name: &str,
	new_name: &str,
	kind: SelectorTokenKind,
) -> Result<ProcedureExecutionResult> {
	let language = buffer.language().as_str();
	let edits = match language {
		"html" => rename_html_tokens(buffer, old_name, new_name, kind)?,
		"css" => rename_css_selector_tokens(buffer, resolved, old_name, new_name, kind)?,
		_ => {
			return Err(proof_gap(
				"HTML/CSS exact token rename is only supported in html or css buffers",
				"resolved target belongs to an unsupported host language",
				"unsupported_host_region",
				None,
			));
		},
	};

	if edits.is_empty() {
		return Err(proof_gap(
			"No exact literal token matched the requested rename",
			"buffer scan found zero proven literal matches for the selected token",
			"file_local_exact_scan",
			Some(0),
		));
	}

	let reason = match (language, kind) {
		("html", SelectorTokenKind::Class) => {
			"renamed literal class tokens in static HTML attributes"
		},
		("html", SelectorTokenKind::Id) => "renamed literal id attributes in the current HTML buffer",
		("css", SelectorTokenKind::Class) => {
			"renamed exact CSS class selector tokens in the current stylesheet"
		},
		("css", SelectorTokenKind::Id) => {
			"renamed exact CSS id selector tokens in the current stylesheet"
		},
		_ => unreachable!(),
	};

	Ok(ProcedureExecutionResult {
		proof: Some(ProcedureProof {
			basis:      "file_local_exact_scan".into(),
			reason:     reason.into(),
			confidence: "high".into(),
			matches:    Some(edits.len()),
		}),
		edits,
	})
}

fn rename_html_tokens(
	buffer: &CodeBuffer,
	old_name: &str,
	new_name: &str,
	kind: SelectorTokenKind,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let attr_name = match kind {
		SelectorTokenKind::Class => "class",
		SelectorTokenKind::Id => "id",
	};
	let mut edits = Vec::new();
	walk_named(buffer.tree().root_node(), &mut |node| {
		if node.kind() != "attribute" || !attribute_name_matches(node, source.as_str(), attr_name) {
			return Ok(());
		}
		let Some((value_start, value_end, value_text)) = attribute_value_range(node, source.as_str())
		else {
			return Ok(());
		};
		let replacement = match kind {
			SelectorTokenKind::Class => {
				replace_space_separated_token(&value_text, old_name, new_name)?
			},
			SelectorTokenKind::Id => replace_id_value(&value_text, old_name, new_name)?,
		};
		if let Some(new_text) = replacement {
			edits.push(TextEdit { start_byte: value_start, old_end_byte: value_end, new_text });
		}
		Ok(())
	})?;
	Ok(edits)
}

fn rename_css_selector_tokens(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	old_name: &str,
	new_name: &str,
	kind: SelectorTokenKind,
) -> Result<Vec<TextEdit>> {
	if resolved.kind != "rule" {
		return Err(proof_gap(
			"Exact selector-token rename requires a CSS rule target",
			"resolved symbol is not a CSS rule",
			"symbol_shape",
			None,
		));
	}
	if resolved.name.contains(',') {
		return Err(proof_gap(
			"Selector-list rename refused: resolve one exact selector rule first",
			"selector list contains multiple sibling selectors",
			"selector_list_ambiguity",
			None,
		));
	}

	let source = buffer.source();
	let node_kind = match kind {
		SelectorTokenKind::Class => "class_name",
		SelectorTokenKind::Id => "id_name",
	};
	let mut edits = Vec::new();
	walk_named(buffer.tree().root_node(), &mut |node| {
		if node.kind() == node_kind
			&& node_text(source.as_str(), node).is_some_and(|text| text == old_name)
		{
			edits.push(replace_node(node, new_name));
		}
		Ok(())
	})?;
	Ok(edits)
}

fn replace_space_separated_token(
	value: &str,
	old_name: &str,
	new_name: &str,
) -> Result<Option<String>> {
	let tokens = value.split_whitespace().collect::<Vec<_>>();
	if !tokens.contains(&old_name) {
		return Ok(None);
	}
	if !tokens.iter().all(|token| is_safe_selector_token(token)) {
		return Err(proof_gap(
			"HTML class rename refused: attribute contains unsupported token syntax",
			"matched class attribute includes non-literal or unsupported class syntax",
			"literal_token_proof_gap",
			None,
		));
	}
	let pattern = Regex::new(&format!(r"(?P<pre>^|\s){}(?P<post>$|\s)", regex::escape(old_name)))
		.map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	Ok(Some(
		pattern
			.replace_all(value, |captures: &regex::Captures<'_>| {
				format!("{}{}{}", &captures["pre"], new_name, &captures["post"])
			})
			.into_owned(),
	))
}

fn replace_id_value(value: &str, old_name: &str, new_name: &str) -> Result<Option<String>> {
	if value != old_name {
		return Ok(None);
	}
	if !is_safe_selector_token(value) {
		return Err(proof_gap(
			"HTML id rename refused: attribute is not a plain literal token",
			"matched id attribute contains unsupported literal syntax",
			"literal_token_proof_gap",
			None,
		));
	}
	Ok(Some(new_name.to_string()))
}

fn normalize_selector_token(input: &str, prefix: char) -> Result<String> {
	let normalized = input.trim().trim_start_matches(prefix);
	if normalized.is_empty() || !is_safe_selector_token(normalized) {
		return Err(proof_gap(
			"New selector token must be a plain literal class/id name",
			"replacement token is empty or contains unsupported selector characters",
			"replacement_validation",
			None,
		));
	}
	Ok(normalized.to_string())
}

fn normalize_custom_property_name(input: &str) -> Result<String> {
	let normalized = input.trim();
	let bare = normalized.strip_prefix("--").unwrap_or(normalized);
	if bare.is_empty() || !is_safe_selector_token(bare) {
		return Err(proof_gap(
			"New custom property must be a plain literal token",
			"replacement custom-property token is empty or contains unsupported characters",
			"replacement_validation",
			None,
		));
	}
	Ok(format!("--{bare}"))
}

fn extract_selector_token(name: &str, prefix: char) -> Option<&str> {
	let start = name.rfind(prefix)? + prefix.len_utf8();
	let suffix = &name[start..];
	let end = suffix
		.find(|ch: char| ch == '.' || ch == '#' || ch == '[' || ch.is_whitespace())
		.unwrap_or(suffix.len());
	(end > 0).then_some(&suffix[..end])
}

fn attribute_name_matches(node: Node<'_>, source: &str, attr_name: &str) -> bool {
	named_children(node)
		.into_iter()
		.find(|child| child.kind() == "attribute_name")
		.and_then(|child| node_text(source, child))
		.is_some_and(|name| name == attr_name)
}

fn attribute_value_range(node: Node<'_>, source: &str) -> Option<(usize, usize, String)> {
	let value_node = named_children(node)
		.into_iter()
		.find_map(|child| match child.kind() {
			"quoted_attribute_value" => named_children(child)
				.into_iter()
				.find(|grandchild| grandchild.kind() == "attribute_value")
				.or(Some(child)),
			"attribute_value" => Some(child),
			_ => None,
		})?;
	let raw = node_text(source, value_node)?;
	let trimmed = raw.trim_matches('"').trim_matches('\'');
	let start_trim = raw.find(trimmed).unwrap_or(0);
	let value_start = value_node.start_byte() + start_trim;
	let value_end = value_start + trimmed.len();
	Some((value_start, value_end, trimmed.to_string()))
}

fn is_var_function_arg(node: Node<'_>, source: &str) -> bool {
	let Some(arguments) = node.parent() else {
		return false;
	};
	if arguments.kind() != "arguments" {
		return false;
	}
	let Some(call) = arguments.parent() else {
		return false;
	};
	if call.kind() != "call_expression" {
		return false;
	}
	named_children(call)
		.into_iter()
		.find(|child| child.kind() == "function_name")
		.and_then(|child| node_text(source, child))
		.is_some_and(|name| name == "var")
}

fn is_safe_selector_token(token: &str) -> bool {
	let mut chars = token.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	if !(first.is_ascii_alphabetic() || first == '_' || first == '-') {
		return false;
	}
	chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn replace_node(node: Node<'_>, new_text: &str) -> TextEdit {
	TextEdit {
		start_byte:   node.start_byte(),
		old_end_byte: node.end_byte(),
		new_text:     new_text.to_string(),
	}
}

fn required_content(options: &serde_json::Value) -> Result<&str> {
	options
		.get("content")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| CodeEngineError::Edit("Missing required field: content".into()))
}

fn walk_named<F>(node: Node<'_>, visit: &mut F) -> Result<()>
where
	F: FnMut(Node<'_>) -> Result<()>,
{
	visit(node)?;
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		walk_named(child, visit)?;
	}
	Ok(())
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
	let mut cursor = node.walk();
	node.named_children(&mut cursor).collect()
}

fn node_text<'a>(source: &'a str, node: Node<'_>) -> Option<&'a str> {
	source.get(node.start_byte()..node.end_byte())
}

fn proof_gap(message: &str, reason: &str, basis: &str, matches: Option<usize>) -> CodeEngineError {
	CodeEngineError::Refusal {
		message: message.into(),
		reason: reason.into(),
		confidence: "low".into(),
		basis: basis.into(),
		matches,
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::{
		buffer::CodeBuffer,
		language::{LanguageId, LanguageRegistry},
		resolve::resolve_symbol,
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn buffer(source: &str, language: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new(language), registry()).expect("buffer")
	}

	fn profile(language: &str) -> crate::language::LanguageProfile {
		registry()
			.get(&LanguageId::new(language))
			.expect("profile")
			.clone()
	}

	fn apply_and_get(mut buffer: CodeBuffer, edits: Vec<TextEdit>) -> String {
		buffer.edit_batch(edits).expect("edit");
		buffer.source()
	}

	#[test]
	fn rename_class_token_updates_literal_html_classes() {
		let source = "<div class=\"btn primary\"></div>\n<button class=\"btn\"></button>\n";
		let buffer = buffer(source, "html");
		let resolved = resolve_symbol(&buffer, &profile("html"), "div.btn").expect("resolve");
		let result = rename_class_token(&buffer, &resolved, &serde_json::json!({ "content": "cta" }))
			.expect("rename");
		let output = apply_and_get(buffer, result.edits);
		assert!(output.contains("class=\"cta primary\""));
		assert!(output.contains("class=\"cta\""));
	}

	#[test]
	fn rename_class_token_refuses_selector_lists() {
		let source = ".btn, .link { color: red; }\n";
		let buffer = buffer(source, "css");
		let resolved = resolve_symbol(&buffer, &profile("css"), ".btn, .link").expect("resolve");
		let error = rename_class_token(&buffer, &resolved, &serde_json::json!({ "content": "cta" }))
			.expect_err("should refuse");
		assert!(error.to_string().contains("Selector-list rename refused"));
	}

	#[test]
	fn rename_id_token_updates_literal_html_ids_only() {
		let source = "<button id=\"save\"></button>\n<label for=\"save\"></label>\n";
		let buffer = buffer(source, "html");
		let resolved = resolve_symbol(&buffer, &profile("html"), "button#save").expect("resolve");
		let result =
			rename_id_token(&buffer, &resolved, &serde_json::json!({ "content": "saveButton" }))
				.expect("rename");
		let output = apply_and_get(buffer, result.edits);
		assert!(output.contains("id=\"saveButton\""));
		assert!(output.contains("for=\"save\""));
	}

	#[test]
	fn rename_custom_property_updates_declaration_and_var_references() {
		let source =
			":root { --accent: red; color: var(--accent); background: var(--accent, blue); }\n";
		let buffer = buffer(source, "css");
		let resolved = resolve_symbol(&buffer, &profile("css"), ":root.--accent").expect("resolve");
		let result =
			rename_custom_property(&buffer, &resolved, &serde_json::json!({ "content": "brand" }))
				.expect("rename");
		let output = apply_and_get(buffer, result.edits);
		assert!(output.contains("--brand: red"));
		assert!(output.contains("var(--brand)"));
		assert!(output.contains("var(--brand, blue)"));
	}
}
