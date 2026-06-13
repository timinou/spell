//! Host-agnostic graph-edge resolution (P5.A, PLAN-336).
//!
//! The kernel core of what `pi-natives`' `edge_dispatch` does, minus the napi
//! DTO marshaling: given a `target` whose query contains an Edge combinator
//! (`def→/ref→/call→/import→/bind→`), resolve the prefix to starting symbols,
//! walk the edge over the warm workspace [`CodeGraph`], and return the matched
//! [`NodeRef`]s plus any graph diagnostics.
//!
//! This is the entry a BEAM rustler NIF calls so the BEAM serves graph edges
//! from the SAME warm resident index the NAPI skin uses (one index per node,
//! shared across N agents — WS-B). The napi skin keeps its own thin wrapper
//! (`edge_dispatch`) that adds DTO chunking + artifact staging on top of this.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{CodePath, Combinator, Head, Query, Step},
	dialects::fs::FsResolver,
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver, EdgeResolver, Resolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

use crate::{CodeResolverImpl, EdgeResolverImpl, get_or_build_graph, parse::select_lexer};

/// The result of an edge resolve: matched nodes + any non-fatal graph
/// diagnostics (e.g. a start symbol that produced no edges).
#[derive(Debug, Default)]
pub struct EdgeOutput {
	pub nodes:       Vec<NodeRef>,
	pub diagnostics: Vec<Diagnostic>,
}

/// Does this parsed query contain an Edge combinator? Position returned so the
/// caller can split the chain. Mirrors the NAPI `edge_dispatch` entry guard.
pub fn edge_position(query: &Query) -> Option<usize> {
	query
		.chain
		.iter()
		.position(|(c, _)| matches!(c, Combinator::Edge(_)))
}

/// Resolve an edge `target` rooted at `root` against the warm workspace graph.
///
/// Returns `UnsupportedOperation` if the target has no edge combinator (the
/// caller should route it to `resolve_target` instead) — the kernel keeps the
/// read and edge lanes explicit.
pub fn resolve_edges(
	registry: &Arc<LanguageRegistry>,
	target: &str,
	root: &Path,
	cancel: &CancellationToken,
) -> Result<EdgeOutput, Diagnostic> {
	let (lexer, _parse_diagnostics) = select_lexer(target);
	let cp = parse_code_path(target, &lexer)?;
	let query = cp.query.as_ref().ok_or_else(|| Diagnostic {
		variant: DiagnosticVariant::UnsupportedOperation,
		message: "edge resolution requires a query with an edge combinator".to_string(),
		span:    None,
	})?;
	let edge_pos = edge_position(query).ok_or_else(|| Diagnostic {
		variant: DiagnosticVariant::UnsupportedOperation,
		message: "no edge combinator in target; use resolve_target for read queries".to_string(),
		span:    None,
	})?;

	let edge_kind = match &query.chain[edge_pos].0 {
		Combinator::Edge(k) => k.clone(),
		_ => unreachable!("edge_pos guarded by edge_position"),
	};

	// Split the chain at the edge: the prefix resolves to starting symbols, the
	// trailing step filters the edge results by kind.
	let (prefix_chain, edge_step) = split_at_edge(query, edge_pos);
	let prefix_query = Query { head: query.head.clone(), chain: prefix_chain };
	let prefix_cp =
		CodePath { locator: cp.locator.clone(), query: Some(prefix_query), qualifier: None };

	// ── Resolve the prefix to starting NodeRefs (FS walk → code resolve) ──
	let root = root.to_path_buf();
	let fs_resolver = FsResolver::new(root.clone());
	let file_nodes = fs_resolver.resolve(&prefix_cp, cancel)?;
	let code_resolver = CodeResolverImpl::new(registry.clone());
	let prefix_query_ref = prefix_cp.query.as_ref().unwrap();

	let mut starts: Vec<NodeRef> = Vec::new();
	for file_node in file_nodes {
		if cancel.is_cancelled() {
			break;
		}
		let path = if Path::new(&file_node.locator).is_absolute() {
			PathBuf::from(&file_node.locator)
		} else {
			root.join(&file_node.locator)
		};
		// A file whose code resolver fails is not itself an error in graph
		// traversal — absence of a match just yields no starting node.
		if let Ok(mut nodes) = code_resolver.resolve(&path, prefix_query_ref, None, cancel) {
			starts.append(&mut nodes);
		}
	}

	// ── Build (or fetch warm) the workspace graph + walk edges ──
	let graph = get_or_build_graph(&root).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::NoMatches,
		message: format!("code graph build failed: {e}"),
		span:    None,
	})?;
	let edge_resolver = EdgeResolverImpl::new(graph);

	let mut results: Vec<NodeRef> = Vec::new();
	let mut diagnostics: Vec<Diagnostic> = Vec::new();
	for start in starts {
		if cancel.is_cancelled() {
			break;
		}
		let source = to_graph_locator(&start, &root);
		match edge_resolver.resolve(&source, edge_kind.clone(), Some(1), cancel) {
			Ok(nodes) => results.extend(filter_by_tail_step(nodes, &edge_step)),
			Err(d) => diagnostics.push(d),
		}
	}

	Ok(EdgeOutput { nodes: results, diagnostics })
}

/// Split `query.chain` at `edge_pos` into the prefix chain and the edge's
/// trailing step (after the Edge combinator).
fn split_at_edge(query: &Query, edge_pos: usize) -> (Vec<(Combinator, Step)>, Step) {
	let prefix_chain = query.chain[..edge_pos].to_vec();
	let edge_step = query.chain[edge_pos].1.clone();
	(prefix_chain, edge_step)
}

/// Convert a code-resolver NodeRef into a `file:line` locator the
/// `EdgeResolverImpl` matches. pi-code-graph stores symbols by path RELATIVE to
/// the workspace root, so an absolute prefix would never match — strip root.
fn to_graph_locator(start: &NodeRef, root: &Path) -> NodeRef {
	let line = start
		.metadata
		.get("line")
		.and_then(|v| v.as_u64())
		.unwrap_or(0);
	let abs = if Path::new(&start.locator).is_absolute() {
		PathBuf::from(&start.locator)
	} else {
		root.join(&start.locator)
	};
	let rel = abs
		.strip_prefix(root)
		.map(|p| p.to_path_buf())
		.unwrap_or(abs);
	let mut copy = start.clone();
	copy.locator = format!("{}:{}", rel.display(), line);
	copy
}

/// Trailing-step filter: `§*`/`*` matches everything; `§call_expression`
/// filters edge results by NodeRef.kind.
fn filter_by_tail_step(nodes: Vec<NodeRef>, tail: &Step) -> Vec<NodeRef> {
	match &tail.head {
		Head::NodeKind(k) if k == "*" => nodes,
		Head::NodeKind(want) => {
			let want_pref = format!("§{want}");
			nodes
				.into_iter()
				.filter(|n| n.kind == want_pref || n.kind == *want)
				.collect()
		},
		// A name filter against `<file>:<line>` locators is best-effort; pass
		// through (mirrors edge_dispatch).
		_ => nodes,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	/// A non-edge target is rejected so the caller routes it to resolve_target.
	#[test]
	fn non_edge_target_is_unsupported() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();
		let err = resolve_edges(&registry(), "a.ts::a", root, &CancellationToken::new())
			.expect_err("a read query must be rejected by the edge lane");
		assert!(matches!(err.variant, DiagnosticVariant::UnsupportedOperation));
	}

	/// End-to-end: a real `def→` over a real two-file workspace resolves through
	/// the warm index (get_or_build_graph) + EdgeResolverImpl. Proves the kernel
	/// edge lane works without any napi/DTO layer — the exact path the NIF
	/// calls.
	///
	/// NB: edges come from the STATIC `pi-code-graph` index (tree-sitter), NOT
	/// an LSP. The LSP / type-aware lane (#hover, [type_aware]) is a separate
	/// path the kernel rejects with UnsupportedOperation (host-skin only) —
	/// that is exactly why this edge lane is host-agnostic and can serve from
	/// the BEAM.
	#[test]
	fn def_edge_resolves_cross_file_reference_end_to_end() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		// `helper` is DEFINED in lib.ts and REFERENCED (imported + called) in main.ts.
		std::fs::write(root.join("lib.ts"), b"export function helper() { return 42; }\n").unwrap();
		std::fs::write(
			root.join("main.ts"),
			b"import { helper } from './lib';\nexport const x = helper();\n",
		)
		.unwrap();

		// def→ from the helper definition must find its cross-file reference in
		// main.ts via the static graph. This is NON-vacuous: the fixture is
		// constructed so exactly one referencing file exists.
		let out = resolve_edges(&registry(), "lib.ts::helper def→", root, &CancellationToken::new())
			.expect("edge resolve must succeed end-to-end");
		assert!(
			!out.nodes.is_empty(),
			"def→ must resolve the cross-file reference through the static index, got 0 nodes",
		);
		// The reference is in main.ts (where helper is imported/called), not lib.ts
		// (its own definition site) — proves the graph edge actually traversed.
		assert!(
			out.nodes.iter().any(|n| n.locator.contains("main.ts")),
			"the resolved reference must point at the referencing file main.ts, got {:?}",
			out.nodes.iter().map(|n| &n.locator).collect::<Vec<_>>(),
		);
	}

	/// A cancelled token short-circuits the edge walk (FUP-132 probe semantics
	/// apply here too — the prefix + edge loops both check is_cancelled()).
	#[test]
	fn cancelled_token_short_circuits() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("lib.ts"), b"export function helper() { return 1; }\n").unwrap();
		let token = CancellationToken::new();
		token.cancel();
		let out = resolve_edges(&registry(), "lib.ts::helper def→", root, &token)
			.expect("a cancelled resolve still returns Ok with no work done");
		assert!(out.nodes.is_empty(), "a pre-cancelled walk yields no nodes");
	}
}
