//! Target parsing + read-lane dispatch (P3.3a / PLAN-334).
//!
//! `resolve_target` owns the full host-agnostic read flow that the NAPI skin's
//! `execute_code_path_inner` read branch performs: select a name lexer by file
//! extension, parse the target string into a `CodePath`, then dispatch to the
//! right resolver (text / pure-text / symbol / outline / fs). It is the single
//! entry both skins call so the BEAM rustler path is byte-identical to NAPI by
//! construction — not a re-implementation.
//!
//! Excluded (these need host-only machinery and stay in the pi-natives skin):
//!   - semantic dispatch (#hover/#signature/…) → LSP backend
//!   - URI locators → runtime SchemeRegistry (TS callbacks)
//!   - #diff → git subprocess (diff_qualifier, pi-natives)
//!   - edit / manage → writes, buffer_registry
//! For an excluded shape, `resolve_target` returns an `UnsupportedOperation`
//! diagnostic node; the napi skin keeps handling those branches itself.

use std::{
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
};

use pi_code_path::{
	ast::{Axis, CodePath, FsSegment, Head, Locator},
	dialect::NameLexer,
	dialects::text::TextResolver,
	dialects::fs::FsResolver,
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver, FormatExtractor, Resolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};
use pi_code_engine::language::LanguageRegistry;

use crate::dialect_registry;

// ── Name lexer selection ─────────────────────────────────────────

/// Generic dot-aware lexer used when no language-specific dialect applies
/// (no `::`, empty FS prefix, glob prefix, or unknown extension).
struct DotLexer;

impl NameLexer for DotLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<pi_code_path::ast::NamePayload> {
		use winnow::{Parser, token::take_while};
		let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
			.parse_next(input)?;
		Ok(pi_code_path::ast::NamePayload::Raw(s.to_string()))
	}

	fn render(&self, n: &pi_code_path::ast::NamePayload) -> String {
		match n {
			pi_code_path::ast::NamePayload::Raw(s) => s.clone(),
			pi_code_path::ast::NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(
		&self,
		_n: &pi_code_path::ast::NamePayload,
		_node: tree_sitter::Node<'_>,
		_src: &str,
	) -> bool {
		false
	}
}

static DOT_LEXER_ARC: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();

fn dot_lexer() -> Arc<dyn NameLexer> {
	DOT_LEXER_ARC.get_or_init(|| Arc::new(DotLexer)).clone()
}

/// Thin wrapper so `Arc<dyn NameLexer>` satisfies the `NameLexer` trait bound
/// required by `parse_code_path`.
struct NameLexerWrapper(Arc<dyn NameLexer>);

impl NameLexer for NameLexerWrapper {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<pi_code_path::ast::NamePayload> {
		self.0.parse(input)
	}

	fn render(&self, n: &pi_code_path::ast::NamePayload) -> String {
		self.0.render(n)
	}

	fn matches(
		&self,
		n: &pi_code_path::ast::NamePayload,
		node: tree_sitter::Node<'_>,
		src: &str,
	) -> bool {
		self.0.matches(n, node, src)
	}
}

/// Two-phase lexer selection (verbatim from the NAPI skin):
/// 1. Split `target` on the first `::`.
/// 2. Strip surrounding backticks from the FS prefix.
/// 3. Empty prefix / glob magic / unknown extension → generic `DotLexer`.
/// 4. Otherwise look up the dialect by extension via `select_dialect`.
///
/// The glob-prefix case emits an informational diagnostic (filtered for
/// non-`Name` heads by the caller, mirroring `execute_code_path_inner`).
pub fn select_lexer(target: &str) -> (impl NameLexer, Vec<Diagnostic>) {
	let mut diagnostics = Vec::new();

	let Some(pos) = target.find("::") else {
		return (NameLexerWrapper(dot_lexer()), diagnostics);
	};

	let prefix = &target[..pos];
	let prefix = prefix.strip_prefix('`').unwrap_or(prefix);
	let prefix = prefix.strip_suffix('`').unwrap_or(prefix);

	if prefix.is_empty() {
		return (NameLexerWrapper(dot_lexer()), diagnostics);
	}

	if prefix.chars().any(|c| matches!(c, '*' | '?' | '[' | '{')) {
		diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::Informational,
			message: "glob path prefix means language-specific symbol-name matching is disabled for \
			          this query; this only affects `::SymbolName` style heads, not `::§kind` / \
			          `::¶anchor` / `::field:` axes"
				.to_string(),
			span:    None,
		});
		return (NameLexerWrapper(dot_lexer()), diagnostics);
	}

	if let Some(lexer) = dialect_registry::select_dialect(Path::new(prefix)) {
		(NameLexerWrapper(lexer), diagnostics)
	} else {
		(NameLexerWrapper(dot_lexer()), diagnostics)
	}
}

// ── Read-lane shape predicates (verbatim from the NAPI skin) ──────

fn is_pure_text_query(cp: &CodePath) -> bool {
	let Some(query) = &cp.query else {
		return false;
	};
	let head_kind = match &query.head.head {
		Head::NodeKind(k) => k.as_str(),
		_ => return false,
	};
	matches!(head_kind, "line" | "para" | "chunk") && query.head.axis == Some(Axis::Structural)
}

fn is_text_qualifier_only(cp: &CodePath) -> bool {
	if cp.query.is_some() {
		return false;
	}
	cp.qualifier.as_ref().is_some_and(|q| {
		matches!(q.name.as_str(), "raw" | "bytes" | "lines" | "text" | "match" | "image")
	})
}

fn is_outline_qualifier(cp: &CodePath) -> bool {
	cp.query.is_none() && cp.qualifier.as_ref().is_some_and(|q| q.name == "outline")
}

fn is_diff_qualifier(cp: &CodePath) -> bool {
	cp.query.is_none() && cp.qualifier.as_ref().is_some_and(|q| q.name == "diff")
}

fn is_symbol_query(cp: &CodePath) -> bool {
	cp.query.is_some() && !is_pure_text_query(cp)
}

/// Whether the target shape is one the kernel read lane serves. Mirrors the
/// NAPI read branch minus semantic/URI/diff/edit/manage (host-only).
fn is_uri(cp: &CodePath) -> bool {
	matches!(cp.locator, Locator::Uri(_))
}

/// Semantic qualifier names (#hover/#signature/#type_definition/#type_def/
/// #inlay/#diagnostics + the deprecated #hover_inferred). These dispatch to the
/// LSP backend in the NAPI skin and are NOT served by the kernel read lane. The
/// name set mirrors `pi-natives type_resolver::is_semantic_qualifier`; kept here
/// (not imported) so pi-kernel takes no dependency on the host semantic layer.
fn is_semantic_qualifier(cp: &CodePath) -> bool {
	cp.qualifier.as_ref().is_some_and(|q| {
		matches!(
			q.name.as_str(),
			"hover"
				| "hover_inferred"
				| "type_definition"
				| "type_def"
				| "signature"
				| "inlay"
				| "diagnostics"
		)
	})
}

// ── resolve_target ───────────────────────────────────────────────

/// The result of resolving a read target: the resolved nodes plus any
/// query-level (parse / lexer-selection) diagnostics. The split mirrors the
/// NAPI `CodePathChunk` model, where lexer-selection diagnostics live on the
/// chunk, NOT on a node — folding them onto a node would diverge from NAPI.
#[derive(Debug, Clone, Default)]
pub struct ResolveOutput {
	pub nodes:       Vec<NodeRef>,
	pub diagnostics: Vec<Diagnostic>,
}

/// Parse `target` and resolve it through the host-agnostic read lane.
///
/// `extractors` is injected (not built here) so the kernel stays pure: the
/// NAPI skin passes its `default_extractors()` (incl. the shelling-out
/// Markitdown), while a deterministic caller (e.g. the gate-1 test) passes only
/// the pure JSON/HTML extractors.
///
/// Returns the resolved nodes + query-level diagnostics. The glob-prefix
/// informational diagnostic is filtered for non-`Name` heads, mirroring
/// `execute_code_path_inner`.
pub fn resolve_target(
	registry: &Arc<LanguageRegistry>,
	target: &str,
	root: &Path,
	extractors: &[Arc<dyn FormatExtractor>],
	gitignore: Option<bool>,
	cancel: &CancellationToken,
) -> Result<ResolveOutput, Diagnostic> {
	let (lexer, parse_diagnostics) = select_lexer(target);
	let mut cp = parse_code_path(target, &lexer)?;

	// Filter the glob-lexer informational hint for non-Name heads (it only
	// affects `::SymbolName` resolution). Mirrors napi.rs post-parse filter.
	let head_is_name = cp
		.query
		.as_ref()
		.map(|q| matches!(q.head.head, Head::Name(_)))
		.unwrap_or(false);
	let parse_diagnostics: Vec<Diagnostic> = parse_diagnostics
		.into_iter()
		.filter(|d| {
			let is_glob_lexer_hint = matches!(d.variant, DiagnosticVariant::Informational)
				&& d.message.contains("glob path prefix");
			if is_glob_lexer_hint { head_is_name } else { true }
		})
		.collect();

	let root = root.to_path_buf();

	let nodes: Vec<NodeRef> = match &cp.locator {
		Locator::Uri(_) => {
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: "URI locators are resolved by the host skin (runtime SchemeRegistry), not \
				          the kernel read lane"
					.to_string(),
				span: None,
			});
		},
		Locator::Fs(_) => {
			// Mirror NAPI's semantic-FIRST check (napi.rs:840): #hover/#signature/…
			// dispatch to the LSP backend in the host skin before any text/symbol/
			// diff branch can claim the qualifier. The kernel read lane does not
			// serve them.
			if is_semantic_qualifier(&cp) {
				return Err(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: "semantic qualifiers (#hover/#signature/#type_definition/#inlay/\
					          #diagnostics) are resolved by the host skin (LSP backend), not \
					          the kernel read lane"
						.to_string(),
					span: None,
				});
			} else if is_diff_qualifier(&cp) {
				return Err(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: "#diff is resolved by the host skin (git subprocess), not the kernel \
					          read lane"
						.to_string(),
					span: None,
				});
			} else if is_text_qualifier_only(&cp) || is_pure_text_query(&cp) {
				// gitignore threads to the TextResolver branches ONLY — mirrors NAPI,
				// where the fs/symbol/outline resolvers always use gitignore=true.
				let mut resolver = TextResolver::new(root.clone()).with_extractors(extractors.to_vec());
				if let Some(g) = gitignore {
					resolver = resolver.with_gitignore(g);
				}
				resolver.resolve(&cp, cancel)?
			} else if is_symbol_query(&cp) || is_outline_qualifier(&cp) {
				// Code query / outline: walk files, then code-resolve per file.
				let qualifier = cp.qualifier.take();
				let fs_resolver = FsResolver::new(root.clone());
				let file_nodes = fs_resolver.resolve(&cp, cancel)?;
				let code_resolver = crate::CodeResolverImpl::new(registry.clone());
				// For #outline the resolver runs a universal `§*` query; for a
				// symbol query it uses the parsed query.
				let dummy_query;
				let query = if let Some(q) = cp.query.as_ref() {
					q
				} else {
					dummy_query = pi_code_path::ast::Query::single(pi_code_path::ast::Step {
						axis:       None,
						head:       Head::NodeKind("*".into()),
						predicates: vec![],
					});
					&dummy_query
				};
				let mut results = Vec::new();
				for file_node in file_nodes {
					if cancel.is_cancelled() {
						break;
					}
					let path = if Path::new(&file_node.locator).is_absolute() {
						PathBuf::from(&file_node.locator)
					} else {
						root.join(&file_node.locator)
					};
					match code_resolver.resolve(&path, query, qualifier.as_ref(), cancel) {
						Ok(mut ns) => results.append(&mut ns),
						Err(d) => {
							let mut node = file_node;
							node.diagnostics.push(d);
							results.push(node);
						},
					}
				}
				results
			} else {
				FsResolver::new(root).resolve(&cp, cancel)?
			}
		},
	};

	// Query-level diagnostics (lexer-selection) are returned SEPARATELY, mirroring
	// the NAPI chunk model — never folded onto a node.
	let _ = is_uri; // retained for symmetry / future routing
	let _ = fs_locator_to_path; // retained for the diff branch in the host skin

	Ok(ResolveOutput { nodes, diagnostics: parse_diagnostics })
}

/// Convert an FsLocator to a relative path string (used by the host skin's diff
/// branch; kept here as the kernel owns the locator shape).
pub fn fs_locator_to_path(locator: &Locator) -> String {
	match locator {
		Locator::Fs(fs) => {
			let mut parts: Vec<String> = Vec::new();
			for seg in &fs.segments {
				match seg {
					FsSegment::Literal(s) if s == "/" => {},
					FsSegment::Literal(s) => parts.push(s.clone()),
					FsSegment::Star => parts.push("*".to_string()),
					FsSegment::DoubleStar => parts.push("**".to_string()),
					_ => {},
				}
			}
			if parts.is_empty() { ".".to_string() } else { parts.join("") }
		},
		Locator::Uri(_) => ".".to_string(),
	}
}
