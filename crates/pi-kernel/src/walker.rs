use std::{collections::HashMap, path::Path, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Axis, Combinator, Head, Predicate, Query, Step},
	dialect::LanguageDialect,
	resolver::{CancellationToken, CodeResolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};
use tree_sitter::Node;

/// Tree-sitter backed implementation of [`CodeResolver`].
pub struct CodeResolverImpl {
	pub(super) registry:   Arc<LanguageRegistry>,
	/// Optional root used by mutation.rs to absolutise relative
	/// `Locator::Fs` paths before delegating to `code_buffer::execute`.
	/// FEAT-689 / FEAT-708: without this the legacy code_buffer surface
	/// can't open the host file when the test ran from a tempdir.
	pub(super) root:       Option<std::path::PathBuf>,
	pub(super) session_id: Option<String>,
}

impl CodeResolverImpl {
	pub fn new(registry: Arc<LanguageRegistry>) -> Self {
		Self { registry, root: None, session_id: None }
	}

	pub fn with_root(mut self, root: std::path::PathBuf) -> Self {
		self.root = Some(root);
		self
	}

	pub fn with_session_id(mut self, sid: String) -> Self {
		self.session_id = Some(sid);
		self
	}

	// Accessors (P3.1): the fields stay `pub(super)` so kernel-internal impls
	// touch them directly, but the pi-natives `NativeResolver` newtype (which
	// carries the write/mutation methods) reads them across the crate boundary
	// through these instead of widening the fields to `pub`.
	pub fn registry(&self) -> &Arc<LanguageRegistry> {
		&self.registry
	}

	pub fn root(&self) -> Option<&Path> {
		self.root.as_deref()
	}

	pub fn session_id(&self) -> Option<&str> {
		self.session_id.as_deref()
	}
}

impl CodeResolver for CodeResolverImpl {
	fn resolve(
		&self,
		file: &Path,
		query: &Query,
		_qualifier: Option<&pi_code_path::ast::Qualifier>,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic> {
		let profile = match self.registry.match_path(file) {
			Some(p) => p,
			None => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::NoMatches,
					message: format!("no language profile for path: {}", file.display()),
					span:    None,
				});
			},
		};

		let dialect = match &profile.dialect {
			Some(d) => d,
			None => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: format!(
						"no code dialect for extension {}; falling back to text dialect",
						file.extension().and_then(|e| e.to_str()).unwrap_or("?")
					),
					span:    None,
				});
			},
		};

		let bytes = std::fs::read(file).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::Inaccessible,
			message: format!("read error: {e}"),
			span:    None,
		})?;

		let src = match String::from_utf8(bytes) {
			Ok(s) => s,
			Err(e) => {
				// Latin-1 fallback for v1.
				let bytes = e.into_bytes();
				bytes.iter().map(|&b| b as char).collect::<String>()
			},
		};

		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&profile.ts_language)
			.map_err(|e| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("tree-sitter language error: {e}"),
				span:    None,
			})?;

		let tree = parser.parse(&src, None).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "tree-sitter parse failed".into(),
			span:    None,
		})?;

		// #outline qualifier: return a symbol-first structural map instead of full
		// content. The map foregrounds copy-pasteable `file::Symbol` CodePaths (the
		// editable handle) and relegates line numbers to a secondary hint — this is
		// what steers the agent toward symbol-scoped edits over `:A-B` line slices.
		// Built on the rich pi-code-engine outline (nested children, signatures,
		// exported flags), not a flat top-level walk. `#outline[depth=N]` prunes the
		// tree to N levels (default: full depth).
		if let Some(q) = _qualifier.filter(|q| q.name == "outline") {
			let max_depth = parse_outline_depth(q.args.as_deref());
			// Reuse the tree we already parsed above — the engine outline needs only
			// the root node + source + profile, so there is no second parse here.
			let text = render_outline_map(file, tree.root_node(), &src, profile, max_depth);
			let node = NodeRef {
				locator:     file.to_string_lossy().to_string(),
				range:       0..src.len(),
				kind:        "§outline".into(),
				content:     Some(pi_code_path::types::Content::Text { value: text }),
				metadata:    HashMap::new(),
				diagnostics: vec![],
			};
			return Ok(vec![node]);
		}

		let root = tree.root_node();
		let nodes = evaluate_query(query, vec![root], &src, dialect, cancel);
		// BUG-443: a bare-name query matches BOTH an `export_statement` wrapper
		// and the declaration nested inside it (the TS name lexer delegates
		// through the export wrapper). Collapse to the inner declaration: drop
		// any export wrapper that strictly contains another matched node. This
		// is a no-op for explicit `§export_statement` queries (the inner decl is
		// not in the set) and for bodyless re-exports like `export * from "x"`
		// (nothing nested matched), so those keep returning the wrapper.
		let nodes = collapse_export_wrappers(nodes);
		let symbol_spans = symbol_spans_from_root(root, &src, profile);

		// FEAT-718: Extract a SymbolSlice predicate from the terminal step (if any).
		// The slice transforms each resolved symbol node into a sliced text body.
		let symbol_slice: Option<(Option<i64>, Option<i64>, bool)> =
			query.steps().last().and_then(|step| {
				step.predicates.iter().find_map(|p| match p {
					pi_code_path::ast::Predicate::SymbolSlice { start, end, relative } => {
						Some((*start, *end, *relative))
					},
					_ => None,
				})
			});

		let locator = file.to_string_lossy().into_owned();
		let mut results = Vec::with_capacity(nodes.len());
		for node in nodes {
			let mut metadata = HashMap::new();
			// PLAN-318 W1: expose 1-indexed line so the edge dispatcher can
			// find this symbol in pi-code-graph (which keys symbols by file+line).
			let line = (node.start_position().row + 1) as u32;
			metadata.insert("line".to_string(), serde_json::Value::Number((line as u64).into()));
			attach_node_symbol_metadata(&mut metadata, node.kind(), line, &symbol_spans);
			attach_named_node_symbol_metadata(&mut metadata, node, &src, line);
			let mut nref = NodeRef {
				locator: locator.clone(),
				range: node.start_byte()..node.end_byte(),
				kind: format!("§{}", node.kind()),
				content: None,
				metadata,
				diagnostics: Vec::new(),
			};
			// FEAT-718: Apply SymbolSlice (when present) BEFORE the qualifier so
			// that any subsequent qualifier (e.g. #raw) sees a sliced text body.
			if let Some((s_start, s_end, relative)) = symbol_slice {
				apply_symbol_slice(&mut nref, &node, &src, s_start, s_end, relative);
			}
			if let Some(q) = _qualifier {
				// FUP-099 (FUP-LIVE): #hover, #signature, #type_definition,
				// #inlay, #diagnostics are routed via semantic_dispatch at the
				// napi layer BEFORE reaching the walker. The walker only sees
				// dialect-registered (text/code) qualifiers from here on.
				if let Some(qspec) = dialect.qualifiers.iter().find(|qs| qs.name == q.name) {
					if qspec.applies_to.iter().any(|k| k == node.kind()) {
						if let Some(byte_range) = qspec.resolve.resolve(node, &src, q.args.as_deref()) {
							if byte_range.is_empty() {
								nref.diagnostics.push(Diagnostic {
									variant: DiagnosticVariant::UnsupportedOperation,
									message: "qualifier returned empty range".into(),
									span:    None,
								});
							} else {
								nref.range = byte_range.clone();
								nref.content = Some(pi_code_path::types::Content::Text {
									value: src[byte_range].to_string(),
								});
							}
						}
					} else {
						nref.diagnostics.push(Diagnostic {
							variant: DiagnosticVariant::UnsupportedOperation,
							message: format!(
								"qualifier '{}' does not apply to node kind '{}'",
								q.name,
								node.kind()
							),
							span:    None,
						});
					}
				} else {
					// BUG-444: `#match` / `#captures` are grep-context qualifiers — they
					// read metadata a preceding `[text~=\"re\"]` predicate attaches and
					// are only registered in the TEXT dialect, so on a code/symbol node
					// they fall here. Emit a DOMAIN diagnostic that names the real usage
					// rather than the bare \"unknown qualifier\", matching the corrected
					// find.md capability table (`#match | grep`).
					let message = match q.name.as_str() {
						"match" | "captures" => format!(
							"#{} is a grep-context qualifier: it operates on a [text~=\"re\"] match, \
							 e.g. `file::§line[text~=\"TODO\"]#{}` — not on a bare file/symbol target",
							q.name, q.name
						),
						_ => format!("unknown qualifier '{}'", q.name),
					};
					nref.diagnostics.push(Diagnostic {
						variant: DiagnosticVariant::UnsupportedOperation,
						message,
						span: None,
					});
				}
			}
			// BUG-455: a bare symbol or `§kind[pred]` query carries no qualifier,
			// so neither the qualifier branch nor SymbolSlice populated content.
			// Default it to the matched node's own source span so reads like
			// `file::Symbol` and `§call[text~="x"]` show what matched instead of a
			// bare kind label. The qualifier-present-but-non-applicable path keeps
			// content `None` (it lives in the `_qualifier.is_some()` branch above).
			if nref.content.is_none() && _qualifier.is_none() {
				nref.content = Some(pi_code_path::types::Content::Text {
					value: src[nref.range.clone()].to_string(),
				});
			}
			results.push(nref);
		}

		// BUG-458: a qualifier like `#body`/`#sig` on a name that appears both as a
		// class `method_definition` and an interface `method_signature` (via
		// `implements`) matches both nodes. The signature node has no body, so it
		// emits a spurious `does not apply to node kind` diagnostic alongside the
		// correct result. When at least one sibling DID satisfy the qualifier,
		// these non-applicable-kind matches are noise — drop them so the result set
		// is just the node the agent meant.
		if let Some(q) = _qualifier {
			let non_applicable_msg = format!("qualifier '{}' does not apply to node kind", q.name);
			let has_applicable = results.iter().any(|r| {
				!r.diagnostics
					.iter()
					.any(|d| d.message.starts_with(&non_applicable_msg))
			});
			if has_applicable && results.len() > 1 {
				results.retain(|r| {
					!r.diagnostics
						.iter()
						.any(|d| d.message.starts_with(&non_applicable_msg))
				});
			}
		}

		Ok(results)
	}
}

// ---------------------------------------------------------------------------
// FEAT-718: SymbolSlice application
// ---------------------------------------------------------------------------

/// Apply a `SymbolSlice` predicate to a resolved symbol node, replacing the
/// node ref's range/content/kind with the sliced text body.
///
/// Semantics (FEAT-718):
/// - Absolute (`relative=false`): result = lines `max(start,
///   sym.first)..min(end, sym.last)`. Empty intersection ⇒
///   `symbol-slice-disjoint` diagnostic, range unchanged.
/// - Relative (`relative=true`): result = lines `sym.first + start .. sym.last
///   + end`, each clamped to `[1, file.line_count]`.
/// - Open ends (None) substitute the symbol's own bound for that side.
///
/// FUP-099 (FUP-LIVE) removed the `hover_signature_end` helper that used
/// to power the walker's text-based `#hover` path; `#hover` now flows
/// through `semantic_dispatch` → `AnnotationSemanticBackend` (which uses
/// `EngineProfileExtractor::signature_snippet` for the same purpose).
fn apply_symbol_slice(
	nref: &mut NodeRef,
	node: &Node<'_>,
	src: &str,
	start: Option<i64>,
	end: Option<i64>,
	relative: bool,
) {
	let sym_first = node.start_position().row as i64 + 1;
	let sym_last = node.end_position().row as i64 + 1;
	let line_count = line_count_of(src);
	if line_count == 0 {
		return;
	}

	let (target_first, target_last, requested) = if relative {
		let s_off = start.unwrap_or(0);
		let e_off = end.unwrap_or(0);
		let f = (sym_first + s_off).clamp(1, line_count);
		let l = (sym_last + e_off).clamp(1, line_count);
		(f, l, format!("{s_off:+}..{e_off:+}"))
	} else {
		let req_first = start.unwrap_or(sym_first);
		let req_last = end.unwrap_or(sym_last);
		let first = req_first.max(sym_first);
		let last = req_last.min(sym_last);
		(first, last, format!("{req_first}-{req_last}"))
	};

	if target_first > target_last {
		nref.diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::NoMatches,
			message: format!(
				"symbol-slice-disjoint: requested {requested}, symbol spans {sym_first}-{sym_last}"
			),
			span:    None,
		});
		return;
	}

	let (start_byte, end_byte) = match line_byte_range(src, target_first, target_last) {
		Some(r) => r,
		None => return,
	};

	nref.range = start_byte..end_byte;
	nref.kind = format!("§line[{target_first}..{target_last}]");
	nref.content =
		Some(pi_code_path::types::Content::Text { value: src[start_byte..end_byte].to_string() });
}

fn line_count_of(src: &str) -> i64 {
	if src.is_empty() {
		return 0;
	}
	let mut n: i64 = 1;
	for b in src.bytes() {
		if b == b'\n' {
			n += 1;
		}
	}
	// If the file ends with a newline, the trailing empty "line" is not
	// counted (matches `wc -l`-style convention used by lineCount).
	if src.ends_with('\n') {
		n -= 1;
	}
	n
}

/// Compute the byte range covering lines `[first, last]` (1-indexed, inclusive)
/// in `src`. Returns `None` if either bound is outside the file.
fn line_byte_range(src: &str, first: i64, last: i64) -> Option<(usize, usize)> {
	if first < 1 || last < first {
		return None;
	}
	let bytes = src.as_bytes();
	let mut line: i64 = 1;
	let mut start: Option<usize> = if first == 1 { Some(0) } else { None };
	let mut end: Option<usize> = None;
	for (i, &b) in bytes.iter().enumerate() {
		if b == b'\n' {
			if line == last {
				end = Some(i + 1);
				break;
			}
			line += 1;
			if line == first {
				start = Some(i + 1);
			}
		}
	}
	let s = start?;
	let e = end.unwrap_or(bytes.len());
	if s > e {
		return None;
	}
	Some((s, e))
}

// ---------------------------------------------------------------------------
// Outline map (#outline)
// ---------------------------------------------------------------------------

/// Parse the `depth=N` argument of `#outline[depth=N]`. Mirrors the fs `#tree`
/// arg grammar. Absent / unparseable → full depth (`usize::MAX`).
fn parse_outline_depth(args: Option<&str>) -> usize {
	args
		.and_then(|s| {
			s.trim()
				.strip_prefix("depth=")
				.or_else(|| s.trim().strip_prefix("depth = "))
				.and_then(|n| n.trim().parse::<usize>().ok())
		})
		.unwrap_or(usize::MAX)
}

/// Render a symbol-first outline map for `file` from an already-parsed `root`
/// node + its `src`. Each entry leads with the copy-pasteable `file::Symbol`
/// CodePath (the editable handle), followed by an exported marker (● exported /
/// · local), the node kind, a line hint, and the L0 signature. Nested children
/// are indented and addressed by their dotted symbol path
/// (`file::Parent.child`). Takes the tree the resolver already built — no
/// second parse (option B of the double-parse fix; the warm BufferRegistry
/// cache stays out of the kernel read lane by PLAN-334 design).
fn render_outline_map(
	file: &Path,
	root: Node<'_>,
	src: &str,
	profile: &pi_code_engine::language::LanguageProfile,
	max_depth: usize,
) -> String {
	use pi_code_engine::outline::{EnrichFlags, outline_from_root};

	let rel = file.to_string_lossy();
	// No re-parse: the caller already parsed `src` into `root`; the engine outline
	// walks that node + source directly (see pi_code_engine::outline_from_root).
	let entries = outline_from_root(root, src, profile, EnrichFlags::default());

	let mut lines: Vec<String> = Vec::new();
	let mut count = 0usize;
	for entry in &entries {
		push_outline_entry(&mut lines, &mut count, entry, &rel, None, 0, max_depth);
	}

	let header = format!("{rel}  ·  outline ({count} symbol{})", if count == 1 { "" } else { "s" });
	if lines.is_empty() {
		// Empty-state affordance: no symbols to address → point at the raw read.
		// Kept always-on because the outline itself carries no actionable handle here.
		return format!("{header}\n  (no top-level symbols)\n… full text → {rel}#raw");
	}
	// No always-on teaching hint for the populated case: the rows already ARE the
	// copy-pasteable `file::Symbol` handles, and the host read tool appends a
	// once-per-(session, filetype) hint on auto-outline reads (see get.ts).
	format!("{header}\n{}", lines.join("\n"))
}

/// Trim an over-long signature so outline rows stay scannable. The full
/// signature is always reachable via `file::Symbol#sig`; the outline shows a
/// preview. Cuts on a UTF-8 char boundary and appends an ellipsis.
fn truncate_sig(sig: &str) -> String {
	const MAX: usize = 72;
	if sig.chars().count() <= MAX {
		return sig.to_string();
	}
	let truncated: String = sig.chars().take(MAX).collect();
	format!("{truncated}…")
}

/// Append one outline entry (and, within `max_depth`, its children) to `lines`.
/// `parent_path` is the dotted symbol path of the enclosing scope, used to
/// compose the child's `file::Parent.child` CodePath.
fn push_outline_entry(
	lines: &mut Vec<String>,
	count: &mut usize,
	entry: &pi_code_engine::outline::OutlineEntry,
	rel: &str,
	parent_path: Option<&str>,
	depth: usize,
	max_depth: usize,
) {
	if depth >= max_depth {
		return;
	}
	let symbol_path =
		parent_path.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
	let indent = "  ".repeat(depth + 1);
	let marker = if entry.exported { '●' } else { '·' };
	// The signature already restates the name + params; show it only when it
	// adds beyond the bare `::Symbol` handle. Trim to keep rows scannable.
	let sig = entry.signature.trim();
	let sig_part = if sig.is_empty() || sig == entry.name {
		String::new()
	} else {
		format!("   {}", truncate_sig(sig))
	};
	// Row drops the repeated file path (it lives once in the header) and leads
	// with the `::Symbol` handle. The full edit target is the header path + this
	// row's `::Symbol` — e.g. header `foo.ts` + `::Bar.method` →
	// `foo.ts::Bar.method`.
	lines.push(format!(
		"{indent}{marker} ::{symbol_path}   {}   L{}{sig_part}",
		entry.kind, entry.line,
	));
	*count += 1;
	for child in &entry.children {
		push_outline_entry(lines, count, child, rel, Some(&symbol_path), depth + 1, max_depth);
	}
}

#[derive(Debug, Clone)]
struct SymbolSpan {
	path:     String,
	kind:     String,
	line:     u32,
	end_line: u32,
}

fn symbol_spans_from_root(
	root: Node<'_>,
	src: &str,
	profile: &pi_code_engine::language::LanguageProfile,
) -> Vec<SymbolSpan> {
	use pi_code_engine::outline::{EnrichFlags, OutlineEntry, outline_from_root};

	fn push_entry(out: &mut Vec<SymbolSpan>, entry: &OutlineEntry, parent_path: Option<&str>) {
		let path = parent_path
			.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
		out.push(SymbolSpan {
			path:     path.clone(),
			kind:     entry.kind.clone(),
			line:     entry.line,
			end_line: entry.end_line,
		});
		for child in &entry.children {
			push_entry(out, child, Some(&path));
		}
	}

	let entries = outline_from_root(root, src, profile, EnrichFlags::default());
	let mut spans = Vec::new();
	for entry in &entries {
		push_entry(&mut spans, entry, None);
	}
	spans
}

fn best_symbol_for_line(spans: &[SymbolSpan], line: u32) -> Option<&SymbolSpan> {
	let mut best: Option<&SymbolSpan> = None;
	for span in spans {
		if line < span.line || line > span.end_line {
			continue;
		}
		let span_width = span.end_line.saturating_sub(span.line);
		let best_width = best.map(|candidate| candidate.end_line.saturating_sub(candidate.line));
		if best_width.is_none_or(|width| span_width <= width) {
			best = Some(span);
		}
	}
	best
}

fn insert_symbol_metadata(
	metadata: &mut HashMap<String, serde_json::Value>,
	prefix: &str,
	span: &SymbolSpan,
) {
	metadata.insert(format!("{prefix}SymbolPath"), serde_json::Value::String(span.path.clone()));
	metadata.insert(format!("{prefix}SymbolKind"), serde_json::Value::String(span.kind.clone()));
	metadata.insert(format!("{prefix}SymbolLine"), serde_json::Value::Number(span.line.into()));
}

fn attach_node_symbol_metadata(
	metadata: &mut HashMap<String, serde_json::Value>,
	node_kind: &str,
	line: u32,
	spans: &[SymbolSpan],
) {
	let Some(span) = best_symbol_for_line(spans, line) else {
		return;
	};
	if span.line == line && (span.kind == node_kind || node_kind.contains(&span.kind)) {
		insert_symbol_metadata(metadata, "", span);
	} else {
		insert_symbol_metadata(metadata, "enclosing", span);
	}
}

fn has_attached_symbol_metadata(metadata: &HashMap<String, serde_json::Value>) -> bool {
	metadata.contains_key("symbolPath") || metadata.contains_key("enclosingSymbolPath")
}

fn attach_named_node_symbol_metadata(
	metadata: &mut HashMap<String, serde_json::Value>,
	node: Node<'_>,
	src: &str,
	line: u32,
) {
	if has_attached_symbol_metadata(metadata) {
		return;
	}
	let Some(name_child) = node.child_by_field_name("name") else {
		return;
	};
	let Some(name) = src.get(name_child.start_byte()..name_child.end_byte()) else {
		return;
	};
	if name.trim().is_empty() {
		return;
	}
	metadata.insert("symbolPath".to_string(), serde_json::Value::String(name.to_string()));
	metadata.insert("symbolKind".to_string(), serde_json::Value::String(node.kind().to_string()));
	metadata.insert("symbolLine".to_string(), serde_json::Value::Number(line.into()));
}

fn is_match_shape_node(node: &NodeRef) -> bool {
	node
		.metadata
		.get("shape")
		.and_then(serde_json::Value::as_str)
		== Some("match")
}

fn node_metadata_line(node: &NodeRef) -> Option<u32> {
	node
		.metadata
		.get("line")
		.and_then(serde_json::Value::as_u64)
		.and_then(|line| u32::try_from(line).ok())
}

fn locator_file_part(locator: &str) -> &str {
	locator.split_once("::").map_or(locator, |(path, _)| path)
}

pub(crate) fn enrich_line_match_nodes_with_symbols(
	registry: &LanguageRegistry,
	root: &Path,
	nodes: &mut [NodeRef],
	cancel: &CancellationToken,
) {
	let mut spans_by_file: HashMap<String, Option<Vec<SymbolSpan>>> = HashMap::new();
	for node in nodes {
		if cancel.is_cancelled() || !is_match_shape_node(node) {
			continue;
		}
		let Some(line) = node_metadata_line(node) else {
			continue;
		};
		let file_key = locator_file_part(&node.locator).to_string();
		let spans = spans_by_file.entry(file_key.clone()).or_insert_with(|| {
			let file_path = Path::new(&file_key);
			let absolute = if file_path.is_absolute() {
				file_path.to_path_buf()
			} else {
				root.join(file_path)
			};
			read_symbol_spans_for_file(registry, &absolute)
		});
		let Some(spans) = spans.as_ref() else {
			continue;
		};
		if let Some(span) = best_symbol_for_line(spans, line) {
			insert_symbol_metadata(&mut node.metadata, "enclosing", span);
		}
	}
}

fn read_symbol_spans_for_file(registry: &LanguageRegistry, file: &Path) -> Option<Vec<SymbolSpan>> {
	let profile = registry.match_path(file)?;
	profile.dialect.as_ref()?;
	let src = match std::fs::read_to_string(file) {
		Ok(src) => src,
		Err(_) => return None,
	};
	let mut parser = tree_sitter::Parser::new();
	if parser.set_language(&profile.ts_language).is_err() {
		return None;
	}
	let tree = parser.parse(&src, None)?;
	Some(symbol_spans_from_root(tree.root_node(), &src, profile))
}

// ---------------------------------------------------------------------------
// Query evaluation
// ---------------------------------------------------------------------------

/// BUG-443: drop `export_statement` wrappers that strictly contain another
/// matched node, collapsing an exported declaration to a single node (the
/// inner decl). Preserves explicit export queries and bodyless re-exports
/// (`export * from "x"`) where no inner sibling matched.
fn collapse_export_wrappers(nodes: Vec<Node<'_>>) -> Vec<Node<'_>> {
	if nodes.len() < 2 {
		return nodes;
	}
	nodes
		.iter()
		.copied()
		.filter(|node| {
			if node.kind() != "export_statement" {
				return true;
			}
			// Keep the wrapper only if no OTHER matched node lives inside it.
			!nodes.iter().any(|other| {
				other.id() != node.id()
					&& other.start_byte() >= node.start_byte()
					&& other.end_byte() <= node.end_byte()
			})
		})
		.collect()
}

fn collect_descendants<'a>(node: Node<'a>, out: &mut Vec<Node<'a>>) {
	out.push(node);
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		collect_descendants(child, out);
	}
}

pub fn evaluate_query<'a>(
	query: &Query,
	starting_nodes: Vec<Node<'a>>,
	src: &'a str,
	dialect: &'a LanguageDialect,
	cancel: &CancellationToken,
) -> Vec<Node<'a>> {
	let mut current = starting_nodes;

	for (_i, (combinator_opt, step)) in query.segments().enumerate() {
		if cancel.is_cancelled() {
			break;
		}

		let mut candidates = Vec::new();

		if let Some(Axis::Field) = step.axis {
			if let Head::FieldName(field) = &step.head {
				for node in &current {
					if let Some(child) = node.child_by_field_name(field) {
						candidates.push(child);
					}
				}
			}
		} else {
			for node in &current {
				let related = match combinator_opt {
					None => {
						let mut all = Vec::new();
						collect_descendants(*node, &mut all);
						all
					},
					Some(Combinator::Child) => {
						let mut cursor = node.walk();
						node.children(&mut cursor).collect::<Vec<_>>()
					},
					Some(Combinator::Descendant) => {
						let mut desc = Vec::new();
						let mut cursor = node.walk();
						for child in node.children(&mut cursor) {
							collect_descendants(child, &mut desc);
						}
						desc
					},
					Some(Combinator::Parent) => node.parent().into_iter().collect::<Vec<_>>(),
					Some(Combinator::Ancestor) => {
						let mut anc = Vec::new();
						let mut n = *node;
						while let Some(p) = n.parent() {
							anc.push(p);
							n = p;
						}
						anc
					},
					Some(Combinator::PrevSibling) => node.prev_sibling().into_iter().collect::<Vec<_>>(),
					Some(Combinator::NextSibling) => node.next_sibling().into_iter().collect::<Vec<_>>(),
					_ => continue,
				};
				candidates.extend(related);
			}
		}

		candidates.retain(|&n| step_matches(step, n, src, dialect));
		candidates =
			apply_positional_predicates(&step.predicates, candidates, query, src, dialect, cancel);

		candidates.sort_by_key(|n| n.id());
		candidates.dedup_by_key(|n| n.id());

		current = candidates;
	}

	current
}

fn step_matches(step: &Step, node: Node<'_>, src: &str, dialect: &LanguageDialect) -> bool {
	if let Some(Axis::Field) = step.axis {
		return predicates_match(&step.predicates, node, src, dialect);
	}

	if !head_matches(&step.head, node, src, dialect) {
		return false;
	}

	predicates_match(&step.predicates, node, src, dialect)
}

fn head_matches(head: &Head, node: Node<'_>, src: &str, dialect: &LanguageDialect) -> bool {
	match head {
		Head::Name(payload) => {
			if dialect.name_lexer.matches(payload, node, src) {
				return true;
			}
			let rendered = dialect.name_lexer.render(payload);
			// Prefer name-field match for declaration-like nodes.
			if let Some(name_child) = node.child_by_field_name("name") {
				if let Some(text) = src.get(name_child.start_byte()..name_child.end_byte()) {
					return text == rendered;
				}
			}
			// Text fallback for expressions / members, but skip raw identifier leaves.
			let kind = node.kind();
			if kind != "identifier" && kind != "property_identifier" && kind != "type_identifier" {
				if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
					if text == rendered {
						return true;
					}
				}
			}
			false
		},
		Head::NodeKind(kind) => {
			// BUG-413 (PLAN-318 W0): raw tree-sitter kind match first (no-regression);
			// fall back to dialect kind_aliases for universal `§function`/`§method`/etc.
			if node.kind() == kind.as_str() {
				return true;
			}
			if let Some(raw_kinds) = dialect.kind_aliases.get(kind.as_str()) {
				return raw_kinds.iter().any(|rk| node.kind() == rk.as_str());
			}
			false
		},
		Head::AnchorName(name) => dialect
			.anchors
			.iter()
			.any(|a| a.name == name.as_str() && (a.matcher)(&node, src)),
		Head::FieldName(_) => true,
		Head::Group(q) => {
			!evaluate_query(q, vec![node], src, dialect, &CancellationToken::new()).is_empty()
		},
	}
}

fn predicates_match(
	predicates: &[Predicate],
	node: Node<'_>,
	src: &str,
	dialect: &LanguageDialect,
) -> bool {
	predicates.iter().all(|p| match p {
		Predicate::Ordinal(_) | Predicate::Range { .. } => true,
		Predicate::HasDescendant(q) => {
			let mut desc = Vec::new();
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				collect_descendants(child, &mut desc);
			}
			desc.into_iter().any(|d| {
				!evaluate_query(q, vec![d], src, dialect, &CancellationToken::new()).is_empty()
			})
		},
		Predicate::HasAncestor(q) => {
			let mut anc = Vec::new();
			let mut n = node;
			while let Some(p) = n.parent() {
				anc.push(p);
				n = p;
			}
			anc.into_iter().any(|a| {
				!evaluate_query(q, vec![a], src, dialect, &CancellationToken::new()).is_empty()
			})
		},
		Predicate::AnchorFilter(name) => dialect
			.anchors
			.iter()
			.any(|a| a.name == name.as_str() && (a.matcher)(&node, src)),
		_ => crate::predicates::eval(p, &node, src, dialect),
	})
}

fn apply_positional_predicates<'a>(
	predicates: &[Predicate],
	mut nodes: Vec<Node<'a>>,
	_query: &Query,
	_src: &str,
	_dialect: &LanguageDialect,
	_cancel: &CancellationToken,
) -> Vec<Node<'a>> {
	for pred in predicates {
		match pred {
			Predicate::Ordinal(n) => {
				let idx = if *n < 0 {
					nodes.len().saturating_sub((-*n) as usize)
				} else {
					*n as usize
				};
				if idx < nodes.len() {
					nodes = vec![nodes[idx]];
				} else {
					nodes.clear();
				}
			},
			Predicate::Range { start, end } => {
				let s = start.map_or(0, |v| {
					if v < 0 {
						nodes.len().saturating_sub((-v) as usize)
					} else {
						v as usize
					}
				});
				let e = end.map_or(nodes.len(), |v| {
					if v < 0 {
						nodes.len().saturating_sub((-v) as usize)
					} else {
						v as usize
					}
				});
				nodes = nodes
					.into_iter()
					.skip(s)
					.take(e.saturating_sub(s))
					.collect();
			},
			_ => {},
		}
	}
	nodes
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use std::io::Write;

	use pi_code_path::ast::{Axis, Combinator, Head, NamePayload, Predicate, Query, Step};

	use super::*;

	fn resolver() -> CodeResolverImpl {
		let reg = LanguageRegistry::with_builtins().expect("builtins");
		CodeResolverImpl::new(Arc::new(reg))
	}

	fn temp_file(ext: &str, content: &str) -> tempfile::NamedTempFile {
		let mut f = tempfile::Builder::new().suffix(ext).tempfile().unwrap();
		f.write_all(content.as_bytes()).unwrap();
		f
	}

	fn run_query(resolver: &CodeResolverImpl, file: &Path, query: Query) -> Vec<NodeRef> {
		resolver
			.resolve(file, &query, None, &CancellationToken::new())
			.unwrap()
	}

	/// Resolve `file` with an `#outline[args]` qualifier and return the single
	/// `§outline` node's rendered text. The query is irrelevant — the outline
	/// branch short-circuits before query evaluation (mirrors how parse.rs runs
	/// a universal `§*` query alongside the qualifier).
	fn run_outline(resolver: &CodeResolverImpl, file: &Path, args: Option<&str>) -> String {
		let query = Query::single(Step {
			axis:       None,
			head:       Head::NodeKind("*".into()),
			predicates: vec![],
		});
		let qual =
			pi_code_path::ast::Qualifier { name: "outline".into(), args: args.map(str::to_string) };
		let results = resolver
			.resolve(file, &query, Some(&qual), &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1, "outline yields exactly one §outline node");
		assert_eq!(results[0].kind, "§outline");
		let Some(pi_code_path::types::Content::Text { value }) = results[0].content.as_ref() else {
			panic!("outline node must carry text content");
		};
		value.clone()
	}

	#[test]
	fn outline_emits_copy_pasteable_symbol_codepaths() {
		// The outline must foreground the editable `file::Symbol` CodePath — NOT a
		// bare `(L40-L51)` line range — so the agent pastes a symbol target back
		// into `edit`, instead of counting lines for a `:A-B` slice.
		let resolver = resolver();
		let f = temp_file(
			".ts",
			"export function greet(name: string): string {\n  return `hi ${name}`;\n}\n\nfunction \
			 local() {}\n",
		);
		let rel = f.path().to_string_lossy().to_string();
		let text = run_outline(&resolver, f.path(), None);
		// Path lives once in the header; rows lead with the bare `::Symbol` handle
		// (header path + row = the full `file::Symbol` edit target).
		assert!(text.contains(&rel), "header carries the file path once: {text}");
		assert!(text.contains("::greet"), "must show ::Symbol handle: {text}");
		assert!(text.contains("::local"), "must list the local fn too: {text}");
		assert!(
			!text.contains(&format!("{rel}::greet")),
			"path must NOT repeat on each row (header-only): {text}"
		);
		// Exported marker present for greet, local marker for local().
		assert!(text.contains('●'), "exported symbol marker: {text}");
		assert!(text.contains('·'), "local symbol marker: {text}");
		// Header counts symbols; line hint is secondary (Lnn), not a range handle.
		assert!(text.contains("outline ("), "header names the outline: {text}");
	}

	#[test]
	fn outline_nests_children_with_dotted_paths() {
		// A class method must be addressable as `file::Class.method` — the dotted
		// symbol path that `edit` accepts for symbol-scoped edits.
		let resolver = resolver();
		let f =
			temp_file(".ts", "export class Bar {\n  method(x: number): void {\n    return;\n  }\n}\n");
		let _rel = f.path().to_string_lossy().to_string();
		let text = run_outline(&resolver, f.path(), None);
		assert!(text.contains("::Bar"), "class row: {text}");
		assert!(
			text.contains("::Bar.method"),
			"nested method must use the dotted child path: {text}"
		);
	}

	#[test]
	fn outline_depth_prunes_nested_children() {
		// `#outline[depth=1]` shows only top-level symbols; the nested method is
		// pruned. depth=2 brings it back.
		let resolver = resolver();
		let f = temp_file(".ts", "export class Bar {\n  method(x: number): void {}\n}\n");
		let _rel = f.path().to_string_lossy().to_string();
		let depth1 = run_outline(&resolver, f.path(), Some("depth=1"));
		assert!(depth1.contains("::Bar"), "depth=1 keeps the class: {depth1}");
		assert!(!depth1.contains("::Bar.method"), "depth=1 must prune the nested method: {depth1}");
		let depth2 = run_outline(&resolver, f.path(), Some("depth=2"));
		assert!(depth2.contains("::Bar.method"), "depth=2 restores the nested method: {depth2}");
	}

	#[test]
	fn parse_outline_depth_grammar() {
		assert_eq!(parse_outline_depth(None), usize::MAX);
		assert_eq!(parse_outline_depth(Some("depth=2")), 2);
		assert_eq!(parse_outline_depth(Some("depth = 3")), 3);
		assert_eq!(parse_outline_depth(Some("garbage")), usize::MAX);
	}

	#[test]
	fn symbol_spans_include_function_declarations() {
		let resolver = resolver();
		let f = temp_file(".ts", "export function foo() {\n  return 1;\n}\n");
		let profile = resolver.registry.match_path(f.path()).expect("profile");
		let src = std::fs::read_to_string(f.path()).unwrap();
		let mut parser = tree_sitter::Parser::new();
		parser.set_language(&profile.ts_language).unwrap();
		let tree = parser.parse(&src, None).unwrap();
		let spans = symbol_spans_from_root(tree.root_node(), &src, profile);
		assert!(
			spans
				.iter()
				.any(|span| span.path == "foo" && span.line == 1),
			"spans: {spans:?}"
		);
	}

	// ------------------------------------------------------------------
	// TypeScript
	// ------------------------------------------------------------------

	#[test]
	fn bare_symbol_query_populates_content() {
		// BUG-455: a bare symbol query (no qualifier) must populate content with
		// the matched node's own source span — otherwise `file::Symbol` renders
		// a bare kind label with no text.
		let resolver = resolver();
		let f = temp_file(".ts", "function foo() {\n  return 1;\n}\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("foo".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		let content = results[0]
			.content
			.as_ref()
			.expect("bare symbol must carry content");
		let pi_code_path::types::Content::Text { value } = content else {
			panic!("expected text content");
		};
		assert!(value.contains("function foo()"), "content must be the decl source: {value:?}");
		assert!(value.contains("return 1;"), "content must include the body: {value:?}");
	}

	#[test]
	fn ts_top_level_function() {
		let resolver = resolver();
		let f = temp_file(".ts", "export function foo() {\n  return 1;\n}\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("foo".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§function_declaration");
		assert_eq!(
			results[0]
				.metadata
				.get("symbolPath")
				.and_then(serde_json::Value::as_str),
			Some("foo")
		);
	}

	// BUG-443: a bare-name query against an EXPORTED declaration must resolve
	// to a single node (the inner decl), not the decl AND its export_statement
	// wrapper. The double-match previously produced a spurious
	// `unsupported_operation` diagnostic on the wrapper for `#body`.
	#[test]
	fn ts_exported_function_resolves_single_node() {
		let resolver = resolver();
		let f = temp_file(".ts", "export function alpha() {\n  return 1;\n}\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("alpha".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1, "exported decl must collapse to one node: {results:?}");
		assert_eq!(results[0].kind, "§function_declaration");
	}

	// Guard: an explicit `export_statement` kind query still returns the
	// wrapper (the inner decl is not in the match set, so nothing collapses).
	#[test]
	fn ts_explicit_export_statement_query_keeps_wrapper() {
		let resolver = resolver();
		let f = temp_file(".ts", "export function alpha() { return 1; }\n");
		let query = Query::single(Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("export_statement".into()),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§export_statement");
	}

	// BUG-444: `#match` on a bare symbol must yield a DOMAIN diagnostic naming
	// the grep-context usage — not the generic "unknown qualifier".
	#[test]
	fn ts_match_qualifier_on_symbol_gives_domain_diagnostic() {
		let resolver = resolver();
		let f = temp_file(".ts", "export function alpha() { return 1; }\n");
		let cp = pi_code_path::parse_code_path(
			"foo.ts::alpha#match",
			&pi_code_path::dialects::typescript::TsNameLexer,
		)
		.unwrap();
		let results = resolver
			.resolve(f.path(), &cp.query.unwrap(), cp.qualifier.as_ref(), &CancellationToken::new())
			.unwrap();
		let msgs: Vec<String> = results
			.iter()
			.flat_map(|r| r.diagnostics.iter().map(|d| d.message.clone()))
			.collect();
		assert!(
			msgs
				.iter()
				.any(|m| m.contains("grep-context") && m.contains("text~")),
			"expected grep-context domain diagnostic, got: {msgs:?}"
		);
		assert!(
			!msgs.iter().any(|m| m.contains("unknown qualifier")),
			"must NOT be the generic unknown-qualifier diagnostic: {msgs:?}"
		);
	}

	// BUG-458: `#body` on a method name that exists both as a class
	// `method_definition` and an interface `method_signature` (via `implements`)
	// must return only the body-bearing definition — the signature match (which
	// can't have a body) is dropped, not surfaced as a spurious diagnostic.
	#[test]
	fn ts_body_on_implements_method_drops_signature_noise() {
		let resolver = resolver();
		let f = temp_file(
			".ts",
			"export interface Handler { handle(x: number): number; }\nexport class Server implements \
			 Handler {\nhandle(x: number): number { return x * 2; }\n}\n",
		);
		let cp = pi_code_path::parse_code_path(
			"foo.ts::Server.handle#body",
			&pi_code_path::dialects::typescript::TsNameLexer,
		)
		.unwrap();
		let results = resolver
			.resolve(f.path(), &cp.query.unwrap(), cp.qualifier.as_ref(), &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1, "only the body-bearing definition should remain: {results:?}");
		assert_eq!(results[0].kind, "§method_definition");
		assert!(
			results[0].diagnostics.is_empty(),
			"no spurious does-not-apply diagnostic: {:?}",
			results[0].diagnostics
		);
		let content = results[0].content.as_ref().expect("body content present");
		let pi_code_path::types::Content::Text { value } = content else {
			panic!("expected text content");
		};
		assert!(value.contains("return x * 2"), "body content: {value:?}");
	}

	// Guard: a bodyless re-export keeps the wrapper (no nested decl matched).
	#[test]
	fn ts_reexport_star_keeps_wrapper() {
		let resolver = resolver();
		let f = temp_file(".ts", "export * from \"./json\";\nexport const x = 1;\n");
		let cp = pi_code_path::parse_code_path(
			"foo.ts::`export * from \"./json\"`",
			&pi_code_path::dialects::typescript::TsNameLexer,
		)
		.unwrap();
		let results = run_query(&resolver, f.path(), cp.query.unwrap());
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§export_statement");
	}

	#[test]
	fn ts_member_expression() {
		let resolver = resolver();
		let f = temp_file(".ts", "const x = Foo.bar;\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("Foo.bar".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§member_expression");
	}

	#[test]
	fn ts_descendant_call_expression() {
		let resolver = resolver();
		let f = temp_file(".ts", "function main() { console.log(1); }\n");
		let query = Query {
			head:  Step {
				axis:       None,
				head:       Head::NodeKind("program".into()),
				predicates: vec![],
			},
			chain: vec![(Combinator::Descendant, Step {
				axis:       Some(Axis::Structural),
				head:       Head::NodeKind("call_expression".into()),
				predicates: vec![],
			})],
		};
		let results = run_query(&resolver, f.path(), query);
		assert!(!results.is_empty());
		assert!(results.iter().all(|r| r.kind == "§call_expression"));
		assert_eq!(
			results[0]
				.metadata
				.get("enclosingSymbolPath")
				.and_then(serde_json::Value::as_str),
			Some("main")
		);
	}

	#[test]
	fn ts_predicate_name_foo() {
		let resolver = resolver();
		let f = temp_file(".ts", "function foo() {}\nfunction bar() {}\n");
		let query = Query::single(Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("function_declaration".into()),
			predicates: vec![Predicate::Attribute { name: "name".into(), value: "foo".into() }],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§function_declaration");
	}

	#[test]
	fn ts_anchor_return() {
		let resolver = resolver();
		let f = temp_file(".ts", "function foo() { return 1; }\n");
		let query = Query::single(Step {
			axis:       Some(Axis::Anchor),
			head:       Head::AnchorName("return".into()),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		// FEAT-672: ¶return matches function containing return (spec 01-typescript.md).
		assert_eq!(results[0].kind, "§function_declaration");
	}

	// ------------------------------------------------------------------
	// Rust
	// ------------------------------------------------------------------

	#[test]
	fn rust_top_level_function() {
		let resolver = resolver();
		let f = temp_file(".rs", "fn bar() {}\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("bar".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§function_item");
	}

	// ------------------------------------------------------------------
	// Python
	// ------------------------------------------------------------------

	#[test]
	fn python_top_level_function() {
		let resolver = resolver();
		let f = temp_file(".py", "def baz():\n    pass\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("baz".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§function_definition");
	}

	// ------------------------------------------------------------------
	// Elixir
	// ------------------------------------------------------------------

	#[test]
	fn elixir_top_level_def() {
		let resolver = resolver();
		let f = temp_file(".ex", "defmodule Calc do\n  def add(a, b), do: a + b\nend\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("Calc.add".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert!(!results.is_empty(), "elixir Calc.add must resolve via dialect");
	}

	#[test]
	fn elixir_exs_defp_resolves() {
		let resolver = resolver();
		let f =
			temp_file(".exs", "defmodule G do\n  defp h(x), do: x * 2\n  def go, do: h(1)\nend\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("G.h".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert!(!results.is_empty(), "elixir defp G.h must resolve via dialect");
	}

	// ------------------------------------------------------------------
	// Markdown
	// ------------------------------------------------------------------

	#[test]
	fn markdown_heading() {
		let resolver = resolver();
		let f = temp_file(".md", "# Hello\n");
		let query = Query::single(Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("atx_heading".into()),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§atx_heading");
	}

	// ------------------------------------------------------------------
	// Error / fallback paths
	// ------------------------------------------------------------------

	#[test]
	fn missing_dialect_fallback() {
		let resolver = resolver();
		let f = temp_file(".unknownext", "whatever\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("x".into())),
			predicates: vec![],
		});
		let err = resolver
			.resolve(f.path(), &query, None, &CancellationToken::new())
			.unwrap_err();
		assert!(
			err.message.contains("no code dialect") || err.message.contains("no language profile")
		);
	}

	#[test]
	fn parse_error_tolerance() {
		let resolver = resolver();
		let f = temp_file(".ts", "function { }\n");
		let query = Query::single(Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind("ERROR".into()),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		// Tree-sitter still produces a tree (with ERROR nodes); walker should function.
		assert!(!results.is_empty());
		assert!(results.iter().any(|r| r.kind == "§ERROR"));
	}

	// ------------------------------------------------------------------
	// FEAT-718: SymbolSlice (symbol + line slice composition)
	// ------------------------------------------------------------------

	/// Build a 20-line TypeScript file where `foo` spans lines 5..18.
	fn ts_with_long_foo() -> tempfile::NamedTempFile {
		let mut src = String::new();
		src.push_str("// L1\n");
		src.push_str("// L2\n");
		src.push_str("// L3\n");
		src.push_str("// L4\n");
		src.push_str("function foo() {\n"); // L5
		for i in 6..=17 {
			src.push_str(&format!("  // body {i}\n"));
		}
		src.push_str("}\n"); // L18
		src.push_str("// L19\n");
		src.push_str("// L20\n");
		temp_file(".ts", &src)
	}

	fn slice_query(name: &str, start: Option<i64>, end: Option<i64>, relative: bool) -> Query {
		Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw(name.into())),
			predicates: vec![Predicate::SymbolSlice { start, end, relative }],
		})
	}

	#[test]
	fn w3a_absolute_inside_symbol_clamps_to_request() {
		let resolver = resolver();
		let f = ts_with_long_foo();
		let results = run_query(&resolver, f.path(), slice_query("foo", Some(8), Some(12), false));
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§line[8..12]");
		let text = match results[0].content.as_ref().expect("content") {
			pi_code_path::types::Content::Text { value } => value.clone(),
			_ => panic!("expected text content"),
		};
		assert!(text.contains("// body 8"), "got: {text}");
		assert!(text.contains("// body 12"));
		assert!(!text.contains("// body 7"));
		assert!(!text.contains("// body 13"));
	}

	#[test]
	fn w3b_absolute_disjoint_emits_diagnostic() {
		let resolver = resolver();
		let f = ts_with_long_foo();
		let results = run_query(&resolver, f.path(), slice_query("foo", Some(1), Some(3), false));
		assert_eq!(results.len(), 1);
		assert!(
			results[0]
				.diagnostics
				.iter()
				.any(|d| d.message.contains("symbol-slice-disjoint")),
			"diagnostics: {:?}",
			results[0].diagnostics
		);
	}

	#[test]
	fn w4a_relative_symmetric() {
		let resolver = resolver();
		let f = ts_with_long_foo();
		// Sym:±2 ⇒ (5-2)..(18+2) = 3..20
		let results = run_query(&resolver, f.path(), slice_query("foo", Some(-2), Some(2), true));
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§line[3..20]");
	}

	#[test]
	fn w4b_relative_asymmetric() {
		let resolver = resolver();
		let f = ts_with_long_foo();
		// Sym:-1..+1 ⇒ (5-1)..(18+1) = 4..19
		let results = run_query(&resolver, f.path(), slice_query("foo", Some(-1), Some(1), true));
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§line[4..19]");
	}

	#[test]
	fn w4e_relative_clamps_to_file_bounds() {
		let resolver = resolver();
		let f = ts_with_long_foo();
		// Sym:-100..+100 ⇒ clamps to (1, 20)
		let results = run_query(&resolver, f.path(), slice_query("foo", Some(-100), Some(100), true));
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§line[1..20]");
	}

	#[test]
	fn line_count_helper_matches_wc_l() {
		assert_eq!(super::line_count_of(""), 0);
		assert_eq!(super::line_count_of("a"), 1);
		assert_eq!(super::line_count_of("a\n"), 1);
		assert_eq!(super::line_count_of("a\nb"), 2);
		assert_eq!(super::line_count_of("a\nb\n"), 2);
		assert_eq!(super::line_count_of("a\nb\nc\n"), 3);
	}

	#[test]
	fn line_byte_range_basic() {
		let src = "l1\nl2\nl3\nl4\n";
		assert_eq!(super::line_byte_range(src, 1, 1), Some((0, 3)));
		assert_eq!(super::line_byte_range(src, 2, 3), Some((3, 9)));
		assert_eq!(super::line_byte_range(src, 4, 4), Some((9, 12)));
	}
}
