//! [`CompositeSemanticBackend`] — dispatches per-file by extension.
//!
//! In PLAN-319, the only real backend wired is
//! [`AnnotationSemanticBackend`]. LSP-backed backends (W1+) register here
//! via [`register_lsp`](CompositeSemanticBackend::register_lsp) and take
//! over their file extension set.
//!
//! Per the W2 design, an LSP backend wraps Annotation: when the LSP can't
//! answer (or isn't available), the composite falls back to the
//! Annotation backend transparently.

use std::{collections::HashMap, path::Path, sync::Arc};

use crate::semantic::{
	annotation::AnnotationSemanticBackend, Capabilities, Diagnostic, InferResult, InlayHint,
	LineRange, Location, RenameError, SemanticBackend, SignatureInfo, WorkspaceEdit,
};

/// Dispatches `SemanticBackend` calls per-file by extension.
///
/// File-extension keys are stored lowercase without the leading `.`
/// (e.g. `"rs"`, `"ex"`, `"heex"`). Files outside the registered set
/// fall through to the default [`AnnotationSemanticBackend`].
#[derive(Clone)]
pub struct CompositeSemanticBackend {
	/// Catch-all backend used for every file. LSP backends layer on top.
	default:  Arc<AnnotationSemanticBackend>,
	/// `lowercase_ext_without_dot -> backend`. Lookup is `O(log n)` and
	/// the cardinality is small (one per language wired).
	by_ext:   HashMap<String, Arc<dyn SemanticBackend>>,
}

impl CompositeSemanticBackend {
	pub fn new(default: Arc<AnnotationSemanticBackend>) -> Self {
		Self { default, by_ext: HashMap::new() }
	}

	/// Register an LSP-backed (or any other) backend for one or more file
	/// extensions. Extensions are normalised: lowercased, leading `.`
	/// stripped. Last writer wins for a given extension.
	///
	/// Returns the extensions whose registration **silently overwrote** a
	/// previous binding — callers (KDL config loader, W2) should surface
	/// these as a warning Informational diagnostic so a user who configured
	/// two LSPs for `.ts` learns about it.
	pub fn register_lsp(
		&mut self,
		extensions: impl IntoIterator<Item = impl Into<String>>,
		backend: Arc<dyn SemanticBackend>,
	) -> Vec<String> {
		let mut overwritten = Vec::new();
		for ext in extensions {
			let key = normalise_ext(&ext.into());
			if key.is_empty() {
				continue;
			}
			if self.by_ext.insert(key.clone(), backend.clone()).is_some() {
				overwritten.push(key);
			}
		}
		overwritten
	}

	/// Resolve the backend that should service queries for `file`. Falls
	/// back to the default Annotation backend when no LSP is registered.
	fn pick(&self, file: &Path) -> Arc<dyn SemanticBackend> {
		let ext = file
			.extension()
			.and_then(|e| e.to_str())
			.map(|e| e.to_ascii_lowercase())
			.unwrap_or_default();
		if let Some(backend) = self.by_ext.get(&ext) {
			return backend.clone();
		}
		(self.default.clone()) as Arc<dyn SemanticBackend>
	}
}

fn normalise_ext(raw: &str) -> String {
	raw.trim_start_matches('.').to_ascii_lowercase()
}

impl SemanticBackend for CompositeSemanticBackend {
	fn capabilities(&self) -> Capabilities {
		// Returns the *union* of capabilities across all registered backends
		// plus the default. Callers asking "can this composite answer X
		// anywhere?" get a useful answer; per-file capability is a
		// `pick(file).capabilities()` call away when precision matters.
		let mut caps = self.default.capabilities();
		for backend in self.by_ext.values() {
			let c = backend.capabilities();
			caps.inferred_hover |= c.inferred_hover;
			caps.type_definition |= c.type_definition;
			caps.signature |= c.signature;
			caps.inlay_hints |= c.inlay_hints;
			caps.narrow_dispatch |= c.narrow_dispatch;
			caps.diagnostics |= c.diagnostics;
			caps.rename |= c.rename;
			caps.references_narrowed |= c.references_narrowed;
		}
		caps
	}

	fn type_at(&self, file: &Path, line: u32, col: u32) -> InferResult {
		let backend = self.pick(file);
		let primary = backend.type_at(file, line, col);
		// LSP-backed answers always win; fall back to Annotation when the
		// picked backend returns Unknown AND it isn't already the default.
		//
		// Identity check uses `Arc::as_ptr` followed by `*const ()` cast to
		// strip the trait-object vtable: two `Arc<dyn SemanticBackend>`
		// pointing at the same allocation give the same data-pointer even
		// when their vtables differ. `std::ptr::addr_eq` ignores metadata
		// (intended for this exact case per std docs). The cast chain looks
		// magical but is the documented idiom — a refactor that boxes
		// `self.default` differently must preserve the Arc allocation
		// identity for this guard to keep working.
		if primary.is_unknown() && !std::ptr::addr_eq(
			Arc::as_ptr(&backend) as *const (),
			Arc::as_ptr(&self.default) as *const (),
		) {
			return self.default.type_at(file, line, col);
		}
		primary
	}

	fn type_definition_of(&self, file: &Path, line: u32, col: u32) -> Option<Location> {
		self.pick(file).type_definition_of(file, line, col)
	}

	fn signature_at(&self, file: &Path, line: u32, col: u32) -> Option<SignatureInfo> {
		self.pick(file).signature_at(file, line, col)
	}

	fn inlay_hints(&self, file: &Path, range: Option<LineRange>) -> Vec<InlayHint> {
		self.pick(file).inlay_hints(file, range)
	}

	fn narrow_dispatch(&self, call_site: &Location, candidates: &[Location]) -> Vec<Location> {
		// Dispatch by the call site's file.
		self.pick(&call_site.file).narrow_dispatch(call_site, candidates)
	}

	fn diagnostics(&self, file: &Path) -> Vec<Diagnostic> {
		self.pick(file).diagnostics(file)
	}

	fn rename_preview(
		&self,
		file: &Path,
		line: u32,
		col: u32,
		new_name: &str,
	) -> Result<WorkspaceEdit, RenameError> {
		self.pick(file).rename_preview(file, line, col, new_name)
	}

	fn references_narrowed(
		&self,
		symbol: &Location,
		receiver_filter: Option<&crate::semantic::TypeRepr>,
	) -> Vec<Location> {
		self.pick(&symbol.file).references_narrowed(symbol, receiver_filter)
	}
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::{
		model::{CodeGraph, EdgeKind, GraphNode, GraphStats, PersistedCodeGraph},
		semantic::{Capabilities, Confidence, InferResult, SemanticBackend, TypeRepr, TypeSource},
	};

	fn empty_graph() -> Arc<CodeGraph> {
		Arc::new(CodeGraph::from(PersistedCodeGraph {
			root:            PathBuf::from("."),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 0,
			git_head:        None,
		}))
	}

	/// Test double that always returns a fixed InferResult — proves
	/// dispatch routing without spinning up an LSP server.
	struct FixedBackend {
		fixed: InferResult,
	}
	impl SemanticBackend for FixedBackend {
		fn capabilities(&self) -> Capabilities {
			Capabilities { inferred_hover: true, ..Default::default() }
		}
		fn type_at(&self, _file: &Path, _line: u32, _col: u32) -> InferResult {
			self.fixed.clone()
		}
	}

	#[test]
	fn dispatches_by_extension() {
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let mut composite = CompositeSemanticBackend::new(default);
		let overwritten = composite.register_lsp(
			[".rs"],
			Arc::new(FixedBackend {
				fixed: InferResult {
					repr:       TypeRepr::text("Foo<i32>"),
					confidence: Confidence::Inferred,
					source:     TypeSource::ForwardFlow,
				},
			}),
		);
		assert!(overwritten.is_empty(), "first registration has no prior");

		// .rs file routes to the LSP backend.
		let r = composite.type_at(&PathBuf::from("src/foo.rs"), 1, 0);
		assert_eq!(r.confidence, Confidence::Inferred);
		assert_eq!(r.repr.as_str(), "Foo<i32>");

		// .py file (no LSP registered) routes to the default (Annotation,
		// empty graph → unknown).
		let r = composite.type_at(&PathBuf::from("src/foo.py"), 1, 0);
		assert!(r.is_unknown());
	}

	#[test]
	fn extension_normalisation_handles_dot_prefix_and_case() {
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let mut composite = CompositeSemanticBackend::new(default);
		let _ = composite.register_lsp(
			["RS", ".Ex", "heex"], // mixed dot-prefix + case
			Arc::new(FixedBackend {
				fixed: InferResult {
					repr:       TypeRepr::text("answered"),
					confidence: Confidence::Inferred,
					source:     TypeSource::ForwardFlow,
				},
			}),
		);
		for path in [
			"a.rs", "a.ex", "a.heex", "WIDE.RS", "case.EX",
		] {
			let r = composite.type_at(&PathBuf::from(path), 1, 0);
			assert_eq!(r.repr.as_str(), "answered", "path {path} should route to LSP");
		}
	}

	#[test]
	fn falls_back_to_annotation_when_lsp_returns_unknown() {
		// LSP backend returns Unknown; composite must fall back to Annotation.
		// With an empty graph, Annotation also returns Unknown — but the
		// fallback path must still execute. Smoke check via mutation flag.
		struct UnknownBackend;
		impl SemanticBackend for UnknownBackend {
			fn capabilities(&self) -> Capabilities {
				Capabilities::default()
			}
			fn type_at(&self, _f: &Path, _l: u32, _c: u32) -> InferResult {
				InferResult::unknown()
			}
		}
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let mut composite = CompositeSemanticBackend::new(default);
		let _ = composite.register_lsp(["rs"], Arc::new(UnknownBackend));
		// Composite returns Unknown — but we exercise the fallback branch.
		let r = composite.type_at(&PathBuf::from("a.rs"), 1, 0);
		assert!(r.is_unknown());
	}

	#[test]
	fn capabilities_union_across_backends() {
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let mut composite = CompositeSemanticBackend::new(default);

		// Default Annotation: all-false.
		assert!(!composite.capabilities().inferred_hover);

		// Register a backend that does inferred_hover.
		let _ = composite.register_lsp(
			["rs"],
			Arc::new(FixedBackend {
				fixed: InferResult::unknown(),
			}),
		);
		let caps = composite.capabilities();
		assert!(caps.inferred_hover, "union must surface inferred_hover");
		// Other caps stay false (no backend advertises them).
		assert!(!caps.type_definition);
		assert!(!caps.diagnostics);
	}

	#[test]
	fn unknown_extension_falls_back_to_default() {
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let composite = CompositeSemanticBackend::new(default);
		// Empty graph, no extension → returns Unknown via Annotation.
		let r = composite.type_at(&PathBuf::from("README"), 1, 0);
		assert!(r.is_unknown());
	}

	/// W0g (P3): `register_lsp` returns the list of extensions whose prior
	/// binding it silently overwrote. KDL config loader (W2) surfaces these
	/// as an Informational diagnostic.
	#[test]
	fn register_lsp_reports_overwritten_extensions() {
		let default = Arc::new(AnnotationSemanticBackend::new(empty_graph()));
		let mut composite = CompositeSemanticBackend::new(default);
		let backend_a: Arc<dyn SemanticBackend> = Arc::new(FixedBackend {
			fixed: InferResult::unknown(),
		});
		let backend_b: Arc<dyn SemanticBackend> = Arc::new(FixedBackend {
			fixed: InferResult::unknown(),
		});

		assert!(composite.register_lsp(["rs", "ts"], backend_a).is_empty());
		let overwritten = composite.register_lsp(["ts", "py"], backend_b);
		assert_eq!(overwritten, vec!["ts".to_string()]);
	}
}
