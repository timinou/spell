//! Host-agnostic edit preparation (P5.B, PLAN-336).
//!
//! The kernel-side core of what `pi-natives`' `code_buffer` did for a SINGLE
//! edit action: given a parsed action JSON + a resolved target, produce the
//! `TextEdit`s to apply — with NO napi types. Both skins call this:
//! - the NAPI `executeCodeBuffer` batch path (pi-natives) for its per-op step,
//! - the BEAM NIF edit lane (via `pi-kernel`'s mutation resolver).
//!
//! Everything here returns `pi_code_engine::CodeEngineError` (already
//! host-agnostic) and operates on `CodeBuffer` / `serde_json::Value`. The napi
//! DTO rendering (`render_edit_results`, the `executeCodeBuffer` orchestration,
//! the batch `execute_operation_node`) stays bridge-side in pi-natives.
//!
//! Why pi-kernel and not pi-code-engine: the `remove-dead-style` action needs
//! `pi-code-graph` (graph_dead_code proof), and pi-code-graph DEPENDS ON
//! pi-code-engine — so the proof cannot live in pi-code-engine (cycle). pi-kernel
//! already deps both engine and graph (since P5.A), so the whole cluster sits
//! here cleanly.

use std::path::Path;

use pi_code_engine::{
	CodeEngineError,
	buffer::CodeBuffer,
	edit::{
		DragDirection, Occurrence, Patch, ReplacePolicy, SpliceMode, TextEdit, apply_patches,
		apply_raw_text_patches, clone_node, drag_node, insert_after, insert_after_symbol,
		insert_before, insert_before_symbol, kill_node, rename_symbol, replace_body,
		replace_body_safe, splice_node, transpose_nodes, wrap_node,
	},
	language::LanguageProfile,
	procedure::ProcedureProof,
	resolve::{ByteRange, ResolvedSymbol, resolve_symbol},
	run_procedure,
	workspace_root_for,
};
use pi_code_graph::{
	BuildGraphOptions, CacheStore, CodeGraphBuilder, LanguageRegistry as GraphLanguageRegistry,
};
use serde_json::Value;
use tree_sitter::Node;

/// A prepared single edit: the byte edits to apply plus optional proof.
#[derive(Debug)]
pub struct PreparedEditOperation {
	pub edits:  Vec<TextEdit>,
	pub proof:  Option<ProcedureProof>,
	pub action: String,
}

// ── small JSON accessors (CodeEngineError-based) ─────────────────

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, CodeEngineError> {
	value
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| CodeEngineError::Edit(format!("Missing required field: {field}")))
}

fn value_to_usize(value: Option<&Value>, default: usize) -> usize {
	value
		.and_then(Value::as_u64)
		.and_then(|n| usize::try_from(n).ok())
		.unwrap_or(default)
}

fn has_meaningful_index_field(value: Option<&Value>) -> bool {
	value.and_then(Value::as_u64).is_some_and(|n| n > 0)
}

/// Split `<file>::<symbol>` (or bare `<file>`) into (file, Some(symbol)).
pub fn parse_target_id(target_id: &str) -> Result<(String, Option<String>), CodeEngineError> {
	let Some((file_id, symbol_id)) = target_id.split_once("::") else {
		if target_id.trim().is_empty() {
			return Err(CodeEngineError::Edit("targetId must not be empty".into()));
		}
		return Ok((target_id.to_string(), None));
	};
	if file_id.is_empty() || symbol_id.is_empty() {
		return Err(CodeEngineError::Edit(format!(
			"Invalid targetId '{target_id}'. Use '<file>' or '<file>::<symbol>'."
		)));
	}
	Ok((file_id.to_string(), Some(symbol_id.to_string())))
}

// ── action field accessors ───────────────────────────────────────

pub fn action_content(action: &Value) -> Result<&str, CodeEngineError> {
	required_str(action, "content")
}

pub fn action_find(action: &Value) -> Result<&str, CodeEngineError> {
	required_str(action, "find")
}

pub fn action_line(action: &Value, resolved: Option<&ResolvedSymbol>) -> usize {
	action
		.get("line")
		.and_then(Value::as_u64)
		.and_then(|line| usize::try_from(line).ok())
		.filter(|line| *line > 0)
		.or_else(|| resolved.map(|symbol| symbol.line as usize))
		.or_else(|| {
			action
				.get("pos")
				.and_then(Value::as_str)
				.and_then(|pos| pos.split('#').next())
				.and_then(|num| num.parse().ok())
		})
		.unwrap_or(0)
}

pub fn action_allow_sibling_delete(action: &Value) -> bool {
	action.get("allowSiblingDelete").and_then(Value::as_bool).unwrap_or(false)
}

pub fn action_occurrence(action: &Value) -> Result<Occurrence, CodeEngineError> {
	match action.get("occurrence") {
		None | Some(Value::Null) => Ok(Occurrence::Unique),
		Some(Value::String(value)) => match value.as_str() {
			"first" => Ok(Occurrence::First),
			"last" => Ok(Occurrence::Last),
			"all" => Ok(Occurrence::All),
			_ => Err(CodeEngineError::Edit("invalid occurrence value".into())),
		},
		Some(Value::Number(value)) => value
			.as_u64()
			.and_then(|index| usize::try_from(index).ok())
			.filter(|index| *index > 0)
			.map(Occurrence::Index)
			.ok_or_else(|| CodeEngineError::Edit("invalid occurrence value".into())),
		Some(_) => Err(CodeEngineError::Edit("invalid occurrence value".into())),
	}
}

pub fn action_force(action: &Value) -> bool {
	action.get("force").and_then(Value::as_bool).unwrap_or(false)
}

pub fn action_within(resolved: Option<&ResolvedSymbol>) -> Option<(usize, usize)> {
	let symbol = resolved?;
	Some((symbol.start_byte, symbol.end_byte))
}

pub fn range_for_action(kind: &str, resolved: &ResolvedSymbol) -> ByteRange {
	match kind {
		"rename" => resolved.identifier_range,
		"wrap" | "splice" | "move" | "clone" => resolved.statement_range,
		_ => resolved.declaration_range,
	}
}

pub fn statement_within(resolved: Option<&ResolvedSymbol>) -> Option<(usize, usize)> {
	let symbol = resolved?;
	Some((symbol.statement_range.start, symbol.statement_range.end))
}

pub fn action_column(action: &Value) -> usize {
	value_to_usize(action.get("column"), 0)
}

pub fn action_node_type(action: &Value) -> &str {
	action.get("nodeType").and_then(Value::as_str).unwrap_or("")
}

pub fn action_mode(action: &Value) -> SpliceMode {
	match action.get("mode").and_then(Value::as_str).unwrap_or("self") {
		"up" => SpliceMode::Up,
		"down" => SpliceMode::Down,
		_ => SpliceMode::Self_,
	}
}

pub fn target_range(buffer: &CodeBuffer, resolved: Option<&ResolvedSymbol>) -> (usize, usize) {
	match resolved {
		Some(symbol) => (symbol.start_byte, symbol.end_byte),
		None => (0, buffer.source().len()),
	}
}

pub fn would_leave_zero_bytes(buffer: &CodeBuffer, edits: &[TextEdit]) -> bool {
	let mut result = buffer.source().to_string();
	let mut sorted: Vec<_> = edits.iter().collect();
	sorted.sort_by_key(|e| std::cmp::Reverse(e.start_byte));
	for edit in sorted {
		result.replace_range(edit.start_byte..edit.old_end_byte, &edit.new_text);
	}
	result.is_empty()
}

/// FEAT-707: identifier shape check used by clone-with-rename.
pub fn is_valid_identifier(s: &str) -> bool {
	let mut chars = s.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	if !(first.is_alphabetic() || first == '_' || first == '$') {
		return false;
	}
	chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// FEAT-707: replace the first whole-word occurrence of `from` with `to`.
pub fn rename_first_occurrence(text: &str, from: &str, to: &str) -> String {
	if from.is_empty() {
		return text.to_string();
	}
	let bytes = text.as_bytes();
	let from_bytes = from.as_bytes();
	let mut i = 0;
	while i + from_bytes.len() <= bytes.len() {
		if &bytes[i..i + from_bytes.len()] == from_bytes {
			let before_ok = i == 0 || {
				let prev = bytes[i - 1] as char;
				!(prev.is_alphanumeric() || prev == '_' || prev == '$')
			};
			let after_idx = i + from_bytes.len();
			let after_ok = after_idx == bytes.len() || {
				let next = bytes[after_idx] as char;
				!(next.is_alphanumeric() || next == '_' || next == '$')
			};
			if before_ok && after_ok {
				let mut out = String::with_capacity(text.len() - from.len() + to.len());
				out.push_str(&text[..i]);
				out.push_str(to);
				out.push_str(&text[i + from.len()..]);
				return out;
			}
		}
		i += 1;
	}
	text.to_string()
}

// ── EDN path resolution (CodeBuffer/Node only) ───────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum EdnPathSegment {
	Key(String),
	Index(usize),
}

fn parse_edn_path(path: &str) -> Option<Vec<EdnPathSegment>> {
	let inner = path.trim().strip_prefix('[')?.strip_suffix(']')?.trim();
	if inner.is_empty() {
		return Some(Vec::new());
	}
	inner
		.split_whitespace()
		.map(|token| {
			if let Some(key) = token.strip_prefix(':') {
				Some(EdnPathSegment::Key(format!(":{key}")))
			} else {
				token.parse::<usize>().ok().map(EdnPathSegment::Index)
			}
		})
		.collect()
}

pub fn edn_node_text(buffer: &CodeBuffer, node: Node<'_>) -> String {
	buffer.source().get(node.start_byte()..node.end_byte()).unwrap_or_default().to_string()
}

pub fn edn_named_children(node: Node<'_>) -> Vec<Node<'_>> {
	let mut cursor = node.walk();
	node.named_children(&mut cursor).collect()
}

pub fn edn_root_value(buffer: &CodeBuffer) -> Option<Node<'_>> {
	let root = buffer.tree().root_node();
	edn_named_children(root).into_iter().next()
}

fn edn_child_for_segment<'a>(
	buffer: &CodeBuffer,
	node: Node<'a>,
	segment: &EdnPathSegment,
) -> Option<Node<'a>> {
	let children = edn_named_children(node);
	match segment {
		EdnPathSegment::Index(index) => children.get(*index).copied(),
		EdnPathSegment::Key(key) => {
			if node.kind() != "map_lit" {
				return None;
			}
			children.chunks(2).find_map(|pair| {
				let [candidate, value] = pair else {
					return None;
				};
				(edn_node_text(buffer, *candidate) == *key).then_some(*value)
			})
		},
	}
}

/// Resolve an EDN `[…]` path to its node (used by outline + edit). Public so the
/// napi outline path can keep calling it.
pub fn edn_node_for_path<'a>(buffer: &'a CodeBuffer, path: &str) -> Option<Node<'a>> {
	let segments = parse_edn_path(path)?;
	let mut node = edn_root_value(buffer)?;
	for segment in &segments {
		node = edn_child_for_segment(buffer, node, segment)?;
	}
	Some(node)
}

pub fn edn_resolved_symbol(buffer: &CodeBuffer, path: &str) -> Option<ResolvedSymbol> {
	let node = edn_node_for_path(buffer, path)?;
	Some(ResolvedSymbol {
		name:              path.to_string(),
		kind:              node.kind().to_string(),
		start_byte:        node.start_byte(),
		end_byte:          node.end_byte(),
		line:              (node.start_position().row + 1) as u32,
		end_line:          (node.end_position().row + 1) as u32,
		body_start_byte:   None,
		body_end_byte:     None,
		identifier_range:  ByteRange { start: node.start_byte(), end: node.end_byte() },
		declaration_range: ByteRange { start: node.start_byte(), end: node.end_byte() },
		statement_range:   ByteRange { start: node.start_byte(), end: node.end_byte() },
	})
}

/// Build a token-only `ResolvedSymbol` for CSS token procedures (BUG-435).
fn synthetic_token_symbol(name: String) -> ResolvedSymbol {
	ResolvedSymbol {
		name,
		kind: "css-token".into(),
		start_byte: 0,
		end_byte: 0,
		line: 0,
		end_line: 0,
		body_start_byte: None,
		body_end_byte: None,
		identifier_range: ByteRange { start: 0, end: 0 },
		declaration_range: ByteRange { start: 0, end: 0 },
		statement_range: ByteRange { start: 0, end: 0 },
	}
}

/// Resolve a `targetId` against a buffer (EDN-aware), returning the symbol or
/// None for a file-level target.
pub fn resolve_target_id(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	_path: &Path,
	target_id: &str,
) -> Result<Option<ResolvedSymbol>, CodeEngineError> {
	let (_, symbol_target_id) = parse_target_id(target_id)?;
	match symbol_target_id {
		Some(symbol_target_id) if buffer.language().as_str() == "edn" => {
			edn_resolved_symbol(buffer, &symbol_target_id).map(Some).ok_or_else(|| {
				CodeEngineError::Edit(format!("EDN target path '{symbol_target_id}' not found"))
			})
		},
		Some(symbol_target_id) => resolve_symbol(buffer, profile, &symbol_target_id).map(Some),
		None => Ok(None),
	}
}

// ── dead-style proof (needs pi-code-graph) ───────────────────────

/// Prove a CSS rule is dead via the static graph (the `remove-dead-style`
/// procedure's safety gate). Reachable only through the napi `executeCodeBuffer`
/// batch path — the kernel/BEAM edit lane (mutation resolver) never emits
/// `removeDeadStyle`, so this is dormant there.
pub fn prove_dead_style(
	path: &Path,
	resolved: &ResolvedSymbol,
) -> Result<ProcedureProof, CodeEngineError> {
	let root = workspace_root_for(path);
	let cache = CacheStore::new(root.join(".spell/graph"));
	let target_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
	let registry = GraphLanguageRegistry::new()
		.with_defaults()
		.map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let builder = CodeGraphBuilder::new(registry, cache);
	let outcome = builder
		.build(&BuildGraphOptions::new(&root))
		.map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let Some(item) = outcome
		.graph
		.graph_dead_code_with_limit(0)
		.into_iter()
		.find(|item| {
			let item_path = if item.symbol.path.is_absolute() {
				item.symbol.path.clone()
			} else {
				root.join(&item.symbol.path)
			};
			item_path == target_path
				&& item.symbol.kind == "cssrule"
				&& item.symbol.label.ends_with(&format!("::{}", resolved.name))
		})
	else {
		return Err(CodeEngineError::Refusal {
			message:    "Dead-style removal refused: static graph still sees possible consumers or \
			             lacks proof of zero consumers"
				.into(),
			reason:     "graph_dead_code did not prove this CSS rule unused at the requested location"
				.into(),
			confidence: "low".into(),
			basis:      "graph_dead_code".into(),
			matches:    None,
		});
	};
	Ok(ProcedureProof {
		basis:      "graph_dead_code".into(),
		reason:     item.reason,
		confidence: item.confidence,
		matches:    Some(1),
	})
}

// ── the single-action edit preparer ──────────────────────────────

/// Prepare ONE edit action into `TextEdit`s. Host-agnostic; the napi batch path
/// and the kernel/BEAM mutation resolver both call this.
pub fn single_action(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	path: &Path,
	target_id: &str,
	action: &Value,
) -> Result<PreparedEditOperation, CodeEngineError> {
	let action_kind = action
		.get("kind")
		.and_then(Value::as_str)
		.ok_or_else(|| CodeEngineError::Edit("Each action requires 'kind'".into()))?;
	// BUG-435: renameCustomProperty operates on a literal token, not a selector.
	let resolved = if action_kind == "renameCustomProperty" {
		let (_, token) = parse_target_id(target_id)?;
		token
			.map(synthetic_token_symbol)
			.or_else(|| resolve_target_id(buffer, profile, path, target_id).ok().flatten())
	} else {
		resolve_target_id(buffer, profile, path, target_id)?
	};
	let conservative_web_refactor = matches!(buffer.language().as_str(), "html" | "css");
	let within = action_within(resolved.as_ref());

	let prepared = match action_kind {
		"write" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), action.get("scope").and_then(Value::as_str)) {
				(Some(symbol), Some("body")) => PreparedEditOperation {
					edits:  if action_allow_sibling_delete(action) {
						replace_body(buffer, symbol, content, ReplacePolicy {
							allow_sibling_delete: true,
						})?
					} else {
						replace_body_safe(buffer, symbol, content)?
					},
					proof:  None,
					action: action_kind.to_string(),
				},
				(Some(symbol), Some("sig")) => {
					let body_start = symbol.body_start_byte.ok_or_else(|| {
						CodeEngineError::Edit(format!(
							"Symbol '{}' (kind: {}) has no body; cannot scope to signature",
							symbol.name, symbol.kind
						))
					})?;
					PreparedEditOperation {
						edits:  vec![TextEdit {
							start_byte:   symbol.start_byte,
							old_end_byte: body_start,
							new_text:     content.to_string(),
						}],
						proof:  None,
						action: action_kind.to_string(),
					}
				},
				(Some(symbol), _) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   symbol.start_byte,
						old_end_byte: symbol.end_byte,
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
				(None, Some(scope @ ("body" | "sig"))) => {
					return Err(CodeEngineError::Edit(format!(
						"write scope '{scope}' requires a declaration targetId, not a file targetId"
					)));
				},
				(None, _) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   0,
						old_end_byte: buffer.source().len(),
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"findAndReplace" => {
			let (start_byte, end_byte) = target_range(buffer, resolved.as_ref());
			PreparedEditOperation {
				edits:  apply_patches(buffer, start_byte, end_byte, &[Patch {
					find:       action_find(action)?.to_string(),
					replace:    action_content(action)?.to_string(),
					occurrence: action_occurrence(action)?,
					force:      action_force(action),
				}])?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"rawTextReplace" => {
			let (start_byte, end_byte) = target_range(buffer, resolved.as_ref());
			PreparedEditOperation {
				edits:  apply_raw_text_patches(buffer, start_byte, end_byte, &[Patch {
					find:       action_find(action)?.to_string(),
					replace:    action_content(action)?.to_string(),
					occurrence: action_occurrence(action)?,
					force:      action_force(action),
				}])?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"wrap" => {
			let symbol = resolved
				.as_ref()
				.ok_or_else(|| CodeEngineError::Edit("wrap requires a declaration targetId".into()))?;
			let range = range_for_action("wrap", symbol);
			let mut sym = symbol.clone();
			sym.start_byte = range.start;
			sym.end_byte = range.end;
			PreparedEditOperation {
				edits:  wrap_node(buffer, &sym, action_content(action)?)?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"rename" => {
			if conservative_web_refactor {
				return Err(CodeEngineError::Refusal {
					message:    "HTML/CSS rename is not yet supported safely. Use renameIdToken, \
					             renameClassToken, or renameCustomProperty only when the target is a \
					             provable literal token."
						.into(),
					reason:     "generic rename does not preserve proof for HTML/CSS token semantics"
						.into(),
					confidence: "low".into(),
					basis:      "operation_scope".into(),
					matches:    None,
				});
			}
			let symbol = resolved.as_ref().ok_or_else(|| {
				CodeEngineError::Edit("rename requires a declaration targetId".into())
			})?;
			let range = range_for_action("rename", symbol);
			let mut sym = symbol.clone();
			sym.start_byte = range.start;
			sym.end_byte = range.end;
			PreparedEditOperation {
				edits:  rename_symbol(buffer, &sym, action_content(action)?)?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"delete" => {
			if conservative_web_refactor {
				return Err(CodeEngineError::Refusal {
					message:    "HTML/CSS delete is not yet supported safely. Use removeDeadStyle only \
					             after the static graph proves a CSS rule has no consumers."
						.into(),
					reason:     "generic delete does not preserve proof for HTML/CSS style or markup \
					             reachability"
						.into(),
					confidence: "low".into(),
					basis:      "operation_scope".into(),
					matches:    None,
				});
			}
			let edits = match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => vec![TextEdit {
					start_byte:   symbol.start_byte,
					old_end_byte: symbol.end_byte,
					new_text:     String::new(),
				}],
				_ => kill_node(
					buffer,
					action_line(action, resolved.as_ref()),
					action_node_type(action),
					within,
				)?,
			};
			if would_leave_zero_bytes(buffer, &edits) {
				return Err(CodeEngineError::Edit(
					"zero_byte_delete_blocked: deleting this target would leave the file empty; use a \
					 bare path target to delete the file"
						.into(),
				));
			}
			PreparedEditOperation { edits, proof: None, action: action_kind.to_string() }
		},
		"insertBefore" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => PreparedEditOperation {
					edits:  insert_before_symbol(buffer, symbol, content)?,
					proof:  None,
					action: action_kind.to_string(),
				},
				_ => PreparedEditOperation {
					edits:  insert_before(
						buffer,
						action_line(action, resolved.as_ref()),
						action_node_type(action),
						content,
						within,
					)?,
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"insertAfter" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => PreparedEditOperation {
					edits:  insert_after_symbol(buffer, symbol, content)?,
					proof:  None,
					action: action_kind.to_string(),
				},
				_ => PreparedEditOperation {
					edits:  insert_after(
						buffer,
						action_line(action, resolved.as_ref()),
						action_node_type(action),
						content,
						within,
					)?,
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"splice" => PreparedEditOperation {
			edits:  splice_node(
				buffer,
				action_line(action, resolved.as_ref()),
				action_mode(action),
				statement_within(resolved.as_ref()),
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		"move" => PreparedEditOperation {
			edits:  drag_node(
				buffer,
				action_line(action, resolved.as_ref()),
				match action.get("direction").and_then(Value::as_str).unwrap_or("down") {
					"up" => DragDirection::Up,
					_ => DragDirection::Down,
				},
				statement_within(resolved.as_ref()),
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		"clone" => {
			let mut edits = clone_node(
				buffer,
				action_line(action, resolved.as_ref()),
				statement_within(resolved.as_ref()),
			)?;
			// FEAT-707: rename the cloned identifier when `content` is provided.
			if let Some(new_name) = action.get("content").and_then(Value::as_str)
				&& !new_name.is_empty()
			{
				if !is_valid_identifier(new_name) {
					return Err(CodeEngineError::Edit(format!(
						"clone content must be a valid identifier (got {new_name:?})"
					)));
				}
				if let Some(orig_name) = resolved.as_ref().map(|r| r.name.clone()) {
					for edit in &mut edits {
						edit.new_text = rename_first_occurrence(&edit.new_text, &orig_name, new_name);
					}
				}
			}
			PreparedEditOperation { edits, proof: None, action: action_kind.to_string() }
		},
		"transpose" => PreparedEditOperation {
			edits:  transpose_nodes(
				buffer,
				action_line(action, resolved.as_ref()),
				action_column(action),
				within,
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		other => {
			let procedure_name = match other {
				"renameClassToken" => "rename-class-token",
				"renameIdToken" => "rename-id-token",
				"renameCustomProperty" => "rename-custom-property",
				"removeDeadStyle" => "remove-dead-style",
				_ => other,
			};
			let procedure = profile
				.procedures
				.get(procedure_name)
				.ok_or_else(|| CodeEngineError::Edit(format!("Unknown action kind: {other}")))?;
			let symbol = resolved.as_ref().ok_or_else(|| {
				CodeEngineError::Edit(format!("{other} requires a declaration targetId"))
			})?;
			let mut procedure_options = action.as_object().cloned().unwrap_or_default();
			procedure_options.insert("file".into(), Value::String(path.display().to_string()));
			let mut result =
				run_procedure(procedure, buffer, symbol, profile, &Value::Object(procedure_options))?;
			if procedure_name == "remove-dead-style" {
				result.proof = Some(prove_dead_style(path, symbol)?);
			}
			PreparedEditOperation {
				edits:  result.edits,
				proof:  result.proof,
				action: other.to_string(),
			}
		},
	};

	Ok(prepared)
}

/// Get a language profile by buffer language, host-agnostically (clones the
/// registry's profile). Mirrors the original code_buffer::get_profile.
pub fn get_profile(
	registry: &pi_code_engine::language::LanguageRegistry,
	path: &Path,
	buffer_lang: &pi_code_engine::language::LanguageId,
) -> Result<LanguageProfile, CodeEngineError> {
	registry.get(buffer_lang).cloned().ok_or_else(|| {
		CodeEngineError::Edit(format!("Language profile not found for {}", path.display()))
	})
}

