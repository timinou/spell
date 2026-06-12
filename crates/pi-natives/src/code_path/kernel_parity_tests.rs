//! Gate-1 parity (P3.3a / PLAN-334): `pi_kernel::resolve_target` must produce
//! the SAME read nodes as the NAPI read path (`execute_code_path_inner`) for a
//! corpus of read targets. This is the in-process proof that the host-agnostic
//! kernel entry the future rustler skin will call is byte-identical to NAPI —
//! BEFORE any BEAM toolchain is involved (P3.3b wires the cross-runtime gate).
//!
//! Comparison discipline (anti-flake):
//!   - both sides go through `nodes_to_dtos(..., ARTIFACT_THRESHOLD_HIGH)` so
//!     the representation is identical and no content is artifact-staged;
//!   - nodes are sorted by (locator, range_start, range_end) before compare to
//!     kill walk-order nondeterminism;
//!   - we compare a normalized Debug rendering (DTOs aren't Serialize), which
//!     captures every field including the metadata map.

use std::{path::PathBuf, sync::Arc};

use pi_code_path::resolver::CancellationToken;

use super::marshal::nodes_to_dtos;
use super::napi::{CodePathTaskOptions, NodeRefDto, execute_code_path_inner};

/// A threshold high enough that no content is ever artifact-staged, so DTOs
/// carry inline content on both sides (apples-to-apples).
const NO_STAGING: usize = usize::MAX;

fn opts(target: &str, root: &PathBuf) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "resolve".to_string(),
		target:             target.to_string(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(root.to_string_lossy().to_string()),
		actions:            None,
		manage:             None,
		artifact_threshold: Some(u32::MAX),
		gitignore:          None,
		session_id:         None,
		home:               None,
		session_dir:        None,
	}
}

/// Pure extractors only (no Markitdown shell-out) — matches what a
/// deterministic / BEAM caller would inject.
fn pure_extractors() -> Vec<Arc<dyn pi_code_path::resolver::FormatExtractor>> {
	vec![
		Arc::new(super::extractors::JsonExtractor::new()),
		Arc::new(super::extractors::HtmlReadableExtractor::new()),
	]
}

/// Recursively sort all object keys in a JSON value so the comparison is
/// insensitive to `HashMap` iteration order (RandomState differs per process).
fn canonical_json(v: &serde_json::Value) -> serde_json::Value {
	match v {
		serde_json::Value::Object(map) => {
			let mut sorted = serde_json::Map::new();
			let mut keys: Vec<&String> = map.keys().collect();
			keys.sort();
			for k in keys {
				sorted.insert(k.clone(), canonical_json(&map[k]));
			}
			serde_json::Value::Object(sorted)
		},
		serde_json::Value::Array(arr) => {
			serde_json::Value::Array(arr.iter().map(canonical_json).collect())
		},
		other => other.clone(),
	}
}

/// Render one DTO to a key-canonicalized string (metadata map keys sorted).
fn dto_repr(d: &NodeRefDto) -> String {
	let meta = canonical_json(&d.metadata);
	format!(
		"loc={} range={}..{} kind={} content={:?} meta={} diags={:?}",
		d.locator, d.range_start, d.range_end, d.kind, d.content, meta, d.diagnostics,
	)
}

/// Sort + render a DTO vec to a normalized, order-independent string.
fn normalize(mut dtos: Vec<NodeRefDto>) -> String {
	dtos.sort_by(|a, b| {
		(a.locator.as_str(), a.range_start, a.range_end).cmp(&(
			b.locator.as_str(),
			b.range_start,
			b.range_end,
		))
	});
	dtos.iter().map(dto_repr).collect::<Vec<_>>().join("\n")
}

/// Run a target through BOTH skins and assert the node sets AND the query-level
/// diagnostics match.
fn assert_parity(target: &str, root: &PathBuf) {
	// NAPI path: flatten chunk nodes; collect chunk-level (query) diagnostics.
	let napi_chunks = execute_code_path_inner(opts(target, root), Default::default())
		.unwrap_or_else(|e| panic!("napi resolve failed for {target:?}: {e:?}"));
	let mut napi_nodes: Vec<NodeRefDto> = Vec::new();
	let mut napi_diags: Vec<String> = Vec::new();
	for c in napi_chunks {
		napi_nodes.extend(c.nodes);
		for d in c.diagnostics {
			napi_diags.push(format!("{}:{}", d.variant, d.message));
		}
	}

	// Kernel path.
	let registry = Arc::new(
		pi_code_engine::language::LanguageRegistry::with_builtins().expect("registry"),
	);
	let cancel = CancellationToken::new();
	let out = pi_kernel::resolve_target(&registry, target, root, &pure_extractors(), None, &cancel)
		.unwrap_or_else(|d| panic!("kernel resolve failed for {target:?}: {}", d.message));
	let kernel_dtos = nodes_to_dtos(out.nodes, NO_STAGING);
	let mut kernel_diags: Vec<String> = out
		.diagnostics
		.iter()
		.map(|d| {
			format!("{}:{}", super::marshal::diagnostic_variant_to_string(&d.variant), d.message)
		})
		.collect();

	assert_eq!(
		normalize(napi_nodes),
		normalize(kernel_dtos),
		"NIF/NAPI node parity mismatch for target {target:?}",
	);

	napi_diags.sort();
	kernel_diags.sort();
	assert_eq!(
		napi_diags, kernel_diags,
		"NIF/NAPI diagnostic parity mismatch for target {target:?}",
	);
}

/// Build a small fixture tree covering the corpus shapes.
fn fixture() -> (tempfile::TempDir, PathBuf) {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join("src")).unwrap();
	std::fs::write(
		root.join("foo.ts"),
		"export function bar(x) {\n  return x + 1;\n}\n\nclass Baz {\n  method() { return 2; }\n}\n",
	)
	.unwrap();
	std::fs::write(
		root.join("src/lib.rs"),
		"pub fn hello() -> u32 {\n    42\n}\n\npub fn world() -> u32 {\n    7\n}\n",
	)
	.unwrap();
	std::fs::write(root.join("README.md"), "# Title\n\nSome text.\n\n## Section\n\nMore.\n").unwrap();
	(dir, root)
}

#[test]
fn parity_plain_file_paths() {
	let (_d, root) = fixture();
	assert_parity("foo.ts", &root);
	assert_parity("src/lib.rs", &root);
	assert_parity("README.md", &root);
}

#[test]
fn parity_globs() {
	let (_d, root) = fixture();
	assert_parity("src/**/*.rs", &root);
	assert_parity("*.ts", &root);
}

#[test]
fn parity_line_slices() {
	let (_d, root) = fixture();
	assert_parity("foo.ts:1-3", &root);
	assert_parity("src/lib.rs:1-2", &root);
}

#[test]
fn parity_symbol_queries() {
	let (_d, root) = fixture();
	assert_parity("foo.ts::bar", &root);
	assert_parity("src/lib.rs::§function", &root);
	assert_parity("src/lib.rs::§function#body", &root);
}

#[test]
fn parity_outline() {
	let (_d, root) = fixture();
	assert_parity("foo.ts#outline", &root);
}

#[test]
fn parity_glob_symbol_with_diag() {
	let (_d, root) = fixture();
	// glob prefix + ::SymName → DotLexer fallback + informational diagnostic;
	// the diagnostic must survive identically on both sides.
	assert_parity("src/**/*.rs::hello", &root);
}

#[test]
fn semantic_qualifiers_are_excluded_from_the_kernel_read_lane() {
	// Semantic qualifiers (#hover/#signature/…) dispatch to the LSP backend in
	// the NAPI skin; the kernel read lane must NOT serve them — it returns an
	// UnsupportedOperation Err so a host skin can fall back to its own handling
	// (mirrors NAPI's semantic-first check). Covers the P2 review finding.
	let (_d, root) = fixture();
	let registry = Arc::new(
		pi_code_engine::language::LanguageRegistry::with_builtins().expect("registry"),
	);
	let cancel = CancellationToken::new();
	for target in ["foo.ts::bar#hover", "foo.ts#diagnostics", "src/lib.rs::hello#signature"] {
		let out = pi_kernel::resolve_target(&registry, target, &root, &pure_extractors(), None, &cancel);
		let err = out.expect_err(&format!("{target:?} must be excluded from the kernel read lane"));
		assert!(
			matches!(err.variant, pi_code_path::types::DiagnosticVariant::UnsupportedOperation),
			"{target:?} should return UnsupportedOperation, got {:?}",
			err.variant,
		);
	}
}
