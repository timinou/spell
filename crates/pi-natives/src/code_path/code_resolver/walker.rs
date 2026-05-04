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
	registry: Arc<LanguageRegistry>,
}

impl CodeResolverImpl {
	pub fn new(registry: Arc<LanguageRegistry>) -> Self {
		Self { registry }
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

		let root = tree.root_node();
		let nodes = evaluate_query(query, vec![root], &src, dialect, cancel);

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
								q.name, node.kind()
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
}
