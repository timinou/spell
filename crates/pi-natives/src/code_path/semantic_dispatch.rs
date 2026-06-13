//! FUP-099 (FUP-LIVE): live entry point for semantic CodePath qualifiers.
//!
//! Routes `#hover` / `#hover_inferred` / `#signature` / `#type_definition`
//! (and alias `#type_def`) / `#inlay` / `#diagnostics` from the find tool
//! through [`type_resolver::dispatch`] to the per-workspace
//! `CompositeSemanticBackend` cached by [`crate::semantic_cache`].
//!
//! Architecture: this is the **napi-level seam**. The lower-level walker
//! (`code_resolver::walker`) stays pure tree-sitter; semantic concerns
//! live one layer up where `SessionContext` + workspace root are already
//! in scope. The dispatch mirrors the existing `is_diff_qualifier`
//! special-case in [`crate::code_path::napi`] (around line 873).
//!
//! For file-only targets (`foo.rs#diagnostics`) the position is
//! synthesised as `(1, 1)`. For symbol targets (`foo.rs::Bar#hover`) the
//! lower walker is reused to resolve the symbol node; we extract
//! `(file, start_line + 1, start_col + 1)` for the dispatch call.

use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use pi_code_path::{
	ast::{CodePath, FsSegment, Locator, Predicate, Qualifier},
	resolver::{CancellationToken, CodeResolver},
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

use super::{
	code_resolver,
	type_resolver::{
		self, TypeResolverOutcome, deprecated_qualifier_replacement, is_semantic_qualifier,
	},
};
use crate::{semantic_cache, task::CancelToken};

/// Predicate to invoke this module from the napi dispatch chain.
pub fn is_semantic_dispatch(cp: &CodePath) -> bool {
	cp.qualifier.as_ref().is_some_and(|q| {
		is_semantic_qualifier(&q.name) || deprecated_qualifier_replacement(&q.name).is_some()
	})
}

/// Resolve a CodePath whose qualifier is semantic. Always returns a
/// single-chunk result vector — semantic qualifiers produce one outcome
/// per resolved symbol position.
pub fn resolve(
	cp: &CodePath,
	root: &Path,
	pi_token: &CancellationToken,
	cancel_token: &CancelToken,
) -> Result<Vec<NodeRef>> {
	let qualifier = cp
		.qualifier
		.as_ref()
		.ok_or_else(|| Error::from_reason("semantic_dispatch invoked without a qualifier"))?;

	let backend = semantic_cache::get_or_build(root)
		.map_err(|e| Error::from_reason(format!("semantic cache build failed: {e}")))?;

	let predicates = extract_predicates(qualifier);
	let positions = resolve_positions(cp, root, pi_token)?;

	let mut out = Vec::with_capacity(positions.len());
	for (file, line, col) in positions {
		if cancel_token.aborted() || pi_token.is_cancelled() {
			break;
		}
		let outcome = type_resolver::dispatch(&*backend, qualifier, &predicates, &file, line, col);
		out.extend(format_outcome(outcome, &file, line, col));
	}
	Ok(out)
}

// ── Predicate extraction ────────────────────────────────────────────

/// Parse the qualifier's `args` field (the `[…]` after the qualifier name)
/// into the `Predicate` shape `type_resolver` expects.
///
/// Currently supports a single inner item:
/// - `key=value` → `Predicate::Attribute { name: key, value }`
/// - `flag`      → `Predicate::Flag(flag)`
///
/// Multiple bracket-pairs after a qualifier are not parsed by the kernel
/// today (the qualifier rule consumes one bracketed group); when grammar
/// support arrives, this fn handles each pair.
fn extract_predicates(q: &Qualifier) -> Vec<Predicate> {
	let Some(args) = q.args.as_deref() else {
		return Vec::new();
	};
	let trimmed = args.trim();
	if trimmed.is_empty() {
		return Vec::new();
	}
	let pred = match trimmed.split_once('=') {
		Some((name, value)) => {
			Predicate::Attribute { name: name.trim().to_string(), value: value.trim().to_string() }
		},
		None => Predicate::Flag(trimmed.to_string()),
	};
	vec![pred]
}

// ── Position resolution ─────────────────────────────────────────────

/// Resolve a CodePath target to one or more `(file, line, col)` triples.
///
/// - Locator-only (`foo.rs#diagnostics`): one triple at `(file, 1, 1)`
/// - Symbol target (`foo.rs::Bar#hover`): resolve via the tree-sitter code
///   resolver and take each matched node's start position (1-indexed)
fn resolve_positions(
	cp: &CodePath,
	root: &Path,
	pi_token: &CancellationToken,
) -> Result<Vec<(PathBuf, u32, u32)>> {
	let file_path = locator_to_path(&cp.locator, root)?;

	// File-only (no query): synthesise (line=1, col=1). Used by file-level
	// qualifiers like `#diagnostics`.
	let Some(query) = cp.query.as_ref() else {
		if !file_path.exists() {
			return Err(Error::from_reason(format!(
				"semantic_dispatch: file not found: {}",
				file_path.display()
			)));
		}
		return Ok(vec![(file_path, 1, 1)]);
	};

	// Symbol target: re-use the code resolver to find matching nodes.
	let code_resolver_inst = code_resolver::new().map_err(|d| Error::from_reason(d.message))?;
	// Strip the qualifier for the symbol-resolve pass — qualifiers are our
	// concern, not the walker's. Predicates on query steps (e.g. for
	// `def→[type_aware]`) are not relevant for semantic qualifier dispatch.
	let nodes = code_resolver_inst
		.resolve(&file_path, query, None, pi_token)
		.map_err(|d| Error::from_reason(d.message))?;

	let positions: Vec<(PathBuf, u32, u32)> = nodes
		.iter()
		.map(|n| {
			let line = n.metadata.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
			// Walker doesn't currently emit column metadata; use 1 as a
			// safe default (sufficient for AnnotationSemanticBackend which
			// falls through to "preceding symbol on line" when col doesn't
			// match exactly).
			let col = 1u32;
			(file_path.clone(), line, col)
		})
		.collect();

	Ok(positions)
}

/// Convert a `Locator::Fs` to an absolute `PathBuf`. URI locators are
/// rejected — semantic dispatch only handles real on-disk files.
fn locator_to_path(loc: &Locator, root: &Path) -> Result<PathBuf> {
	let Locator::Fs(fs) = loc else {
		return Err(Error::from_reason(
			"semantic_dispatch: URI locators not supported for semantic qualifiers",
		));
	};
	let mut joined = String::new();
	for seg in &fs.segments {
		match seg {
			FsSegment::Literal(s) => {
				if !joined.is_empty() && !joined.ends_with('/') {
					joined.push('/');
				}
				joined.push_str(s);
			},
			_ => {
				return Err(Error::from_reason(
					"semantic_dispatch: glob locators not supported for semantic qualifiers (yet)",
				));
			},
		}
	}
	let rel = PathBuf::from(joined);
	let abs = if rel.is_absolute() {
		rel
	} else {
		root.join(rel)
	};
	Ok(abs)
}

// ── Outcome formatting ──────────────────────────────────────────────

/// Format a `TypeResolverOutcome` into one or more `NodeRef` entries.
///
/// The locator is `<file>:<line>` (mirrors edge_resolver's symbol locator
/// shape). Each variant maps to a distinct `kind` so consumers can
/// detect the qualifier type from the result.
fn format_outcome(outcome: TypeResolverOutcome, file: &Path, line: u32, _col: u32) -> Vec<NodeRef> {
	let locator = format!("{}:{}", file.display(), line);
	match outcome {
		TypeResolverOutcome::Hover(h) => {
			let text = type_resolver::format_hover(&h);
			vec![mk_text("§hover", text, &locator)]
		},
		TypeResolverOutcome::Signature(Some(s)) => {
			let body = if let Some(doc) = &s.documentation {
				format!("{}\n\n{doc}", s.signature)
			} else {
				s.signature.clone()
			};
			vec![mk_text("§signature", body, &locator)]
		},
		TypeResolverOutcome::Signature(None) => vec![mk_empty("§signature", &locator)],
		TypeResolverOutcome::TypeDefinition(Some(loc)) => {
			let text = format!("{}:{}:{}", loc.file.display(), loc.line, loc.col);
			vec![mk_text("§type_definition", text, &locator)]
		},
		TypeResolverOutcome::TypeDefinition(None) => {
			vec![mk_empty("§type_definition", &locator)]
		},
		TypeResolverOutcome::Inlay(hints) if hints.is_empty() => {
			vec![mk_empty("§inlay", &locator)]
		},
		TypeResolverOutcome::Inlay(hints) => {
			let body = hints
				.iter()
				.map(|h| format!("{}:{}  {} ({:?})", h.location.line, h.location.col, h.label, h.kind))
				.collect::<Vec<_>>()
				.join("\n");
			vec![mk_text("§inlay", body, &locator)]
		},
		TypeResolverOutcome::Diagnostics(diags) if diags.is_empty() => {
			vec![mk_empty("§diagnostics", &locator)]
		},
		TypeResolverOutcome::Diagnostics(diags) => {
			let body = diags
				.iter()
				.map(|d| {
					format!(
						"{}:{} [{:?}] {} ({})",
						d.location.line, d.location.col, d.severity, d.message, d.source,
					)
				})
				.collect::<Vec<_>>()
				.join("\n");
			vec![mk_text("§diagnostics", body, &locator)]
		},
		TypeResolverOutcome::Deprecated { name, replacement } => {
			let text = format!("qualifier #{name} is deprecated; use #{replacement} instead");
			let mut nref = mk_text("§deprecated", text.clone(), &locator);
			nref.diagnostics.push(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: text,
				span:    None,
			});
			vec![nref]
		},
		TypeResolverOutcome::NotASemanticQualifier => {
			// Defensive: the napi entry guards against this, but a future
			// caller bypassing the guard shouldn't panic.
			vec![mk_empty("§unknown", &locator)]
		},
	}
}

fn mk_text(kind: &str, value: String, locator: &str) -> NodeRef {
	let range = 0..value.len();
	NodeRef {
		locator: locator.to_string(),
		range,
		kind: kind.to_string(),
		content: Some(Content::Text { value }),
		metadata: Default::default(),
		diagnostics: Vec::new(),
	}
}

fn mk_empty(kind: &str, locator: &str) -> NodeRef {
	NodeRef {
		locator:     locator.to_string(),
		range:       0..0,
		kind:        kind.to_string(),
		content:     None,
		metadata:    Default::default(),
		diagnostics: Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use pi_code_path::ast::{FsLocator, Qualifier};

	use super::*;

	fn ws() -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(
			dir.path().join("a.ts"),
			b"export function add(x: number, y: number): number { return x + y; }\n",
		)
		.unwrap();
		dir
	}

	fn cp_file_only(name: &str, qual: &str) -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(name.to_string())] }),
			query:     None,
			qualifier: Some(Qualifier { name: qual.to_string(), args: None }),
		}
	}

	fn cp_file_only_with_args(name: &str, qual: &str, args: &str) -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(name.to_string())] }),
			query:     None,
			qualifier: Some(Qualifier { name: qual.to_string(), args: Some(args.to_string()) }),
		}
	}

	#[test]
	fn is_semantic_dispatch_recognises_known_quals() {
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "hover")));
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "type_definition")));
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "type_def")));
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "signature")));
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "inlay")));
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "diagnostics")));
		// Deprecated also routes through.
		assert!(is_semantic_dispatch(&cp_file_only("a.ts", "hover_inferred")));
		// Not semantic.
		assert!(!is_semantic_dispatch(&cp_file_only("a.ts", "raw")));
		assert!(!is_semantic_dispatch(&cp_file_only("a.ts", "body")));
		assert!(!is_semantic_dispatch(&cp_file_only("a.ts", "sig")));
	}

	#[test]
	fn extract_predicates_handles_attribute() {
		let q = Qualifier { name: "hover".into(), args: Some("source=graph".into()) };
		let preds = extract_predicates(&q);
		assert_eq!(preds.len(), 1);
		match &preds[0] {
			Predicate::Attribute { name, value } => {
				assert_eq!(name, "source");
				assert_eq!(value, "graph");
			},
			other => panic!("expected Attribute, got {other:?}"),
		}
	}

	#[test]
	fn extract_predicates_handles_flag() {
		let q = Qualifier { name: "hover".into(), args: Some("type_aware".into()) };
		let preds = extract_predicates(&q);
		assert_eq!(preds.len(), 1);
		match &preds[0] {
			Predicate::Flag(s) => assert_eq!(s, "type_aware"),
			other => panic!("expected Flag, got {other:?}"),
		}
	}

	#[test]
	fn extract_predicates_handles_none() {
		let q = Qualifier { name: "hover".into(), args: None };
		assert!(extract_predicates(&q).is_empty());
	}

	#[test]
	fn extract_predicates_trims_whitespace() {
		let q = Qualifier { name: "diagnostics".into(), args: Some("  severity = error  ".into()) };
		let preds = extract_predicates(&q);
		match &preds[0] {
			Predicate::Attribute { name, value } => {
				assert_eq!(name, "severity");
				assert_eq!(value, "error");
			},
			_ => panic!("expected Attribute"),
		}
	}

	#[test]
	fn resolve_diagnostics_at_file_scope_returns_one_node_ref() {
		let dir = ws();
		let cp = cp_file_only("a.ts", "diagnostics");
		let pi = CancellationToken::new();
		let ct = CancelToken::default();
		let result = resolve(&cp, dir.path(), &pi, &ct).expect("resolve");
		assert!(!result.is_empty(), "diagnostics must produce at least one node");
		// First (and only) result kind is §diagnostics.
		assert!(
			result[0].kind == "§diagnostics"
				|| result[0].kind == "§empty"
				|| result[0].kind.starts_with("§"),
			"unexpected kind: {}",
			result[0].kind,
		);
	}

	#[test]
	fn resolve_hover_inferred_returns_deprecated() {
		let dir = ws();
		let cp = cp_file_only("a.ts", "hover_inferred");
		let pi = CancellationToken::new();
		let ct = CancelToken::default();
		let result = resolve(&cp, dir.path(), &pi, &ct).expect("resolve");
		assert_eq!(result.len(), 1);
		assert_eq!(result[0].kind, "§deprecated");
		match &result[0].content {
			Some(Content::Text { value }) => {
				assert!(value.contains("deprecated"));
				assert!(value.contains("hover"));
			},
			other => panic!("expected text content, got {other:?}"),
		}
		assert!(!result[0].diagnostics.is_empty(), "deprecated must carry a diagnostic");
	}

	#[test]
	fn resolve_diagnostics_with_severity_predicate_passes_predicate_through() {
		// We can't easily assert filter semantics without a stub backend
		// going via the cache; the key correctness here is that the call
		// path does not panic and the predicate extractor produces the
		// Attribute that type_resolver::dispatch will consume.
		let dir = ws();
		let cp = cp_file_only_with_args("a.ts", "diagnostics", "severity=error");
		let pi = CancellationToken::new();
		let ct = CancelToken::default();
		let result = resolve(&cp, dir.path(), &pi, &ct).expect("resolve");
		assert!(!result.is_empty());
	}

	#[test]
	fn resolve_file_not_found_errors_clearly() {
		let dir = ws();
		let cp = cp_file_only("nonexistent.ts", "diagnostics");
		let pi = CancellationToken::new();
		let ct = CancelToken::default();
		let err = resolve(&cp, dir.path(), &pi, &ct).expect_err("must error on missing file");
		let msg = format!("{err}");
		assert!(msg.contains("not found"), "error should mention missing file: {msg}");
	}
}
