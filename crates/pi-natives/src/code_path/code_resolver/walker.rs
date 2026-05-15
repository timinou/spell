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

		let bytes_len = bytes.len();
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

		// #outline qualifier: return symbol outline instead of full content
		if _qualifier.is_some_and(|q| q.name == "outline") {
			let root = tree.root_node();
			let mut cursor = root.walk();
			let children: Vec<_> = root.named_children(&mut cursor).collect();
			let mut lines: Vec<String> = Vec::with_capacity(children.len());
			for child in &children {
				let range = child.start_byte()..child.end_byte();
				let decl_text = src[range].to_string();
				let first_line = decl_text.lines().next().unwrap_or("").to_string();
				lines.push(format!(
					"{} | {} (L{}-L{})",
					first_line,
					child.kind(),
					child.start_position().row + 1,
					child.end_position().row + 1,
				));
			}
			let text = lines.join("\n");
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
			let mut nref = NodeRef {
				locator:     locator.clone(),
				range:       node.start_byte()..node.end_byte(),
				kind:        format!("§{}", node.kind()),
				content:     None,
				metadata:    HashMap::new(),
				diagnostics: Vec::new(),
			};
			// FEAT-718: Apply SymbolSlice (when present) BEFORE the qualifier so
			// that any subsequent qualifier (e.g. #raw) sees a sliced text body.
			if let Some((s_start, s_end, relative)) = symbol_slice {
				apply_symbol_slice(&mut nref, &node, &src, s_start, s_end, relative);
			}
			if let Some(q) = _qualifier {
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
					nref.diagnostics.push(Diagnostic {
						variant: DiagnosticVariant::UnsupportedOperation,
						message: format!("unknown qualifier '{}'", q.name),
						span:    None,
					});
				}
			}
			results.push(nref);
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
// Query evaluation
// ---------------------------------------------------------------------------

fn collect_descendants<'a>(node: Node<'a>, out: &mut Vec<Node<'a>>) {
	out.push(node);
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		collect_descendants(child, out);
	}
}

fn evaluate_query<'a>(
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
		Head::NodeKind(kind) => node.kind() == kind.as_str(),
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
		_ => super::predicates::eval(p, &node, src, dialect),
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

	// ------------------------------------------------------------------
	// TypeScript
	// ------------------------------------------------------------------

	#[test]
	fn ts_top_level_function() {
		let resolver = resolver();
		let f = temp_file(".ts", "function foo() {}\n");
		let query = Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("foo".into())),
			predicates: vec![],
		});
		let results = run_query(&resolver, f.path(), query);
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§function_declaration");
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
