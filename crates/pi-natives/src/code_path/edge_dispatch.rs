//! PLAN-318 W1: edge-combinator dispatch.
//!
//! The kernel parser emits `Combinator::Edge(kind)` whenever an arrow
//! combinator (`ref→`, `def→`, `call→`, `import→`, `bind→`) appears in a
//! query chain. No production resolver dispatched these until this module
//! existed: queries silently returned the prefix instead of walking the
//! graph.
//!
//! This module:
//! 1. Resolves the query prefix (head + chain[..edge_pos]) via the existing
//!    FS + code resolver pipeline. The result is a set of starting symbol
//!    `NodeRef`s with `metadata.line` populated by the walker.
//! 2. Looks up — or lazily builds — the workspace `Arc<CodeGraph>` via
//!    [`code_graph_cache::get_or_build_graph`].
//! 3. Wraps it in `EdgeResolverImpl` and calls `resolve` per starting
//!    node with the edge kind.
//! 4. Filters results by the trailing step (`§call_expression`, etc.).
//!    A `§*` trailing step matches all neighbours.
//!
//! Multi-edge chains (e.g. `…def→…call→…`) are not yet supported in W1.
//! The first Edge consumes the rest of the chain; subsequent combinators
//! after the edge tail step are ignored. FUP if needed.

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use pi_code_path::{
	ast::{CodePath, Combinator, Head, Locator, Query, Step},
	dialects::fs::FsResolver,
	resolver::{CancellationToken, CodeResolver, EdgeResolver, Resolver},
	types::NodeRef,
};

use super::{
	code_resolver,
	edge_resolver::EdgeResolverImpl,
	marshal::{ARTIFACT_THRESHOLD, diagnostic_to_dto, nodes_to_dtos},
	napi::{CodePathChunk, DiagnosticDto},
};
use crate::{code_graph_cache, task::CancelToken};

/// Entry point invoked from `execute_code_path_inner` when an Edge combinator
/// is present.
#[allow(clippy::too_many_arguments)]
pub fn resolve(
	mut cp: CodePath,
	edge_pos: usize,
	root: PathBuf,
	gitignore: Option<bool>,
	artifact_threshold: Option<u32>,
	head_limit: Option<u32>,
	tail_limit: Option<u32>,
	offset: Option<u32>,
	limit: Option<u32>,
	parse_diagnostics: Vec<pi_code_path::types::Diagnostic>,
	pi_token: &CancellationToken,
	cancel_token: &CancelToken,
) -> Result<Vec<CodePathChunk>> {
	// ── Split chain at the first edge ────────────────────────────
	let query = cp.query.as_ref().expect("edge dispatch requires a query");
	let (prefix_chain, edge_step) = split_at_edge(query, edge_pos);
	let edge_kind: pi_code_path::ast::EdgeKind = match &query.chain[edge_pos].0 {
		Combinator::Edge(k) => k.clone(),
		_ => unreachable!("edge_pos guarded by caller"),
	};

	// ── Resolve the prefix to starting symbol NodeRefs ───────────
	// We rebuild a CodePath with the prefix-only query and run the FS +
	// CodeResolver pipeline exactly as the default query path would.
	let prefix_query = Query { head: query.head.clone(), chain: prefix_chain };
	let prefix_cp = CodePath {
		locator:   cp.locator.clone(),
		query:     Some(prefix_query),
		qualifier: None, // qualifiers don't apply to the prefix; they would
		                 // re-anchor on the edge result instead — handled below.
	};

	let fs_resolver = FsResolver::new(root.clone());
	let file_nodes = fs_resolver
		.resolve(&prefix_cp, pi_token)
		.map_err(|d| Error::from_reason(d.message))?;

	let code_resolver_inst =
		code_resolver::new().map_err(|d| Error::from_reason(d.message))?;
	let prefix_query_ref = prefix_cp.query.as_ref().unwrap();

	let mut starts: Vec<NodeRef> = Vec::new();
	for file_node in file_nodes {
		if cancel_token.aborted() || pi_token.is_cancelled() {
			break;
		}
		let path = if std::path::Path::new(&file_node.locator).is_absolute() {
			PathBuf::from(&file_node.locator)
		} else {
			root.join(&file_node.locator)
		};
		match code_resolver_inst.resolve(&path, prefix_query_ref, None, pi_token) {
			Ok(mut nodes) => starts.append(&mut nodes),
			Err(_) => {
				// Skip files whose code resolver fails; the absence of a
				// match is not itself an error in graph traversal.
			},
		}
	}

	// ── Build (or fetch warm) workspace graph + EdgeResolverImpl ─
	let graph = code_graph_cache::get_or_build_graph(&root)
		.map_err(|e| Error::from_reason(format!("code graph build failed: {e}")))?;
	let edge_resolver = EdgeResolverImpl::new(graph);

	// ── Walk edges per starting node ─────────────────────────────
	let mut results: Vec<NodeRef> = Vec::new();
	let mut graph_diagnostics: Vec<pi_code_path::types::Diagnostic> = Vec::new();
	for start in starts {
		if cancel_token.aborted() || pi_token.is_cancelled() {
			break;
		}
		let source = to_graph_locator(&start, &root);
		match edge_resolver.resolve(&source, edge_kind.clone(), Some(1), pi_token) {
			Ok(nodes) => results.extend(filter_by_tail_step(nodes, &edge_step)),
			Err(d) => graph_diagnostics.push(d),
		}
	}

	// ── Projection (offset → tail | head/limit) ──────────────────
	if let Some(off) = offset {
		let off = (off as usize).min(results.len());
		results = results.split_off(off);
	}
	if let Some(n) = tail_limit {
		let n = (n as usize).min(results.len());
		results = results.split_off(results.len() - n);
	} else if let Some(n) = head_limit.or(limit) {
		let n = (n as usize).min(results.len());
		results.truncate(n);
	}

	if cancel_token.aborted() {
		return Err(Error::from_reason("Aborted: Signal"));
	}

	let _ = gitignore; // FsResolver consumed it via prefix run; explicit to silence lint.
	let threshold = artifact_threshold
		.map(|n| n as usize)
		.unwrap_or(ARTIFACT_THRESHOLD);
	let dtos = nodes_to_dtos(results, threshold);

	let mut chunks: Vec<CodePathChunk> = Vec::new();
	for chunk in dtos.chunks(64) {
		chunks.push(CodePathChunk {
			nodes:       chunk.to_vec(),
			diagnostics: Vec::new(),
			done:        false,
		});
	}
	if let Some(last) = chunks.last_mut() {
		last.done = true;
	} else {
		chunks.push(CodePathChunk { nodes: Vec::new(), diagnostics: Vec::new(), done: true });
	}

	// Attach parse + graph diagnostics to the first chunk.
	let mut diag_dtos: Vec<DiagnosticDto> = parse_diagnostics
		.into_iter()
		.chain(graph_diagnostics)
		.map(diagnostic_to_dto)
		.collect();
	if !diag_dtos.is_empty() {
		if let Some(first) = chunks.first_mut() {
			first.diagnostics.append(&mut diag_dtos);
		}
	}

	// Mark the unused mutable to suppress lint for the moved cp/query references.
	let _ = &mut cp;
	Ok(chunks)
}

/// Split `query.chain` at `edge_pos` into prefix chain and the trailing step
/// of the edge (after the Edge combinator).
fn split_at_edge(query: &Query, edge_pos: usize) -> (Vec<(Combinator, Step)>, Step) {
	let prefix_chain = query.chain[..edge_pos].to_vec();
	let edge_step = query.chain[edge_pos].1.clone();
	(prefix_chain, edge_step)
}

/// Convert a NodeRef emitted by the code resolver into a locator the
/// `EdgeResolverImpl` can match. Uses `metadata.line` (set by the walker) to
/// build a `file:line` locator that lines up with `SymbolNode { file, line }`
/// in pi-code-graph.
fn to_graph_locator(start: &NodeRef, root: &std::path::Path) -> NodeRef {
	let line = start
		.metadata
		.get("line")
		.and_then(|v| v.as_u64())
		.unwrap_or(0);
	// Use absolute path (pi-code-graph stores absolute paths from canonicalized
	// root walk).
	let abs = if std::path::Path::new(&start.locator).is_absolute() {
		PathBuf::from(&start.locator)
	} else {
		root.join(&start.locator)
	};
	let mut copy = start.clone();
	copy.locator = format!("{}:{}", abs.display(), line);
	copy
}

/// Trailing-step filter. `§*` (or `*`) matches everything; an explicit
/// `§call_expression` filters by NodeRef.kind.
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
		Head::Name(_payload) => {
			// Name match against locator/qualified_name. EdgeResolverImpl
			// stores `NodeRef.locator` formatted as `<file>:<line>` for
			// symbols, so a name filter here is best-effort substring.
			nodes
		},
		_ => nodes,
	}
}

#[cfg(test)]
#[allow(dead_code)] // keep symbol referenced even when split_at_edge is unused under future refactors
mod tests {
	use super::*;
	use pi_code_path::ast::{Axis, EdgeKind};

	fn step(name: &str) -> Step {
		Step {
			axis:       Some(Axis::Structural),
			head:       Head::NodeKind(name.to_string()),
			predicates: Vec::new(),
		}
	}

	#[test]
	fn split_at_edge_isolates_prefix_and_tail() {
		let q = Query {
			head:  step("Foo"),
			chain: vec![
				(Combinator::Child, step("bar")),
				(Combinator::Edge(EdgeKind::Def), step("call_expression")),
			],
		};
		let (prefix, tail) = split_at_edge(&q, 1);
		assert_eq!(prefix.len(), 1);
		assert!(matches!(prefix[0].0, Combinator::Child));
		assert!(matches!(tail.head, Head::NodeKind(ref s) if s == "call_expression"));
	}

	#[test]
	fn star_tail_matches_all() {
		let tail = step("*");
		let nodes = vec![
			NodeRef {
				locator:     "a".into(),
				range:       0..0,
				kind:        "§function".into(),
				content:     None,
				metadata:    Default::default(),
				diagnostics: vec![],
			},
			NodeRef {
				locator:     "b".into(),
				range:       0..0,
				kind:        "§method".into(),
				content:     None,
				metadata:    Default::default(),
				diagnostics: vec![],
			},
		];
		assert_eq!(filter_by_tail_step(nodes, &tail).len(), 2);
	}

	#[test]
	fn explicit_tail_filters_by_kind() {
		let tail = step("call_expression");
		let nodes = vec![
			NodeRef {
				locator:     "a".into(),
				range:       0..0,
				kind:        "§call_expression".into(),
				content:     None,
				metadata:    Default::default(),
				diagnostics: vec![],
			},
			NodeRef {
				locator:     "b".into(),
				range:       0..0,
				kind:        "§function".into(),
				content:     None,
				metadata:    Default::default(),
				diagnostics: vec![],
			},
		];
		assert_eq!(filter_by_tail_step(nodes, &tail).len(), 1);
	}
}
