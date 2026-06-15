use std::{
	collections::{HashMap, HashSet},
	ops::Range,
	sync::Arc,
};

use tree_sitter::Node;

use crate::ast::{EdgeKind, NamePayload};

// ── NameLexer ────────────────────────────────────────────────────

/// The only dialect-pluggable piece of the CodePath grammar.
/// Each language implements this trait to define how identifier
/// tokens parse, render, and match against tree-sitter nodes.
pub trait NameLexer: Send + Sync {
	/// Parse a name token from input. TS accepts dotted `Foo.bar.baz`;
	/// Rust accepts `crate::a::b::c`; Markdown accepts `ident | "quoted text"`.
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload>;

	/// Render a NamePayload back to its canonical text form.
	fn render(&self, n: &NamePayload) -> String;

	/// Given a NamePayload and a node, does this node's
	/// (NameExtractor output + AttributeEnrichment) match?
	/// The `ctx` parameter carries the LanguageProfile and any dialect-specific
	/// context needed for matching.
	fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool;
}

// ── QualifierResolver ────────────────────────────────────────────

/// Resolves a qualifier to a byte range within a node.
/// E.g. #body on a TS function returns the block range,
/// #sig on a Rust fn returns the signature range.
pub trait QualifierResolver: Send + Sync {
	fn resolve(&self, node: Node<'_>, src: &str, args: Option<&str>) -> Option<Range<usize>>;
}

// ── AnchorPattern ────────────────────────────────────────────────

/// An anchor is a language-registered landmark within a node.
/// Examples: ¶return (TS return statement), ¶test (Rust #[test] fn),
/// ¶async (Python async def), ¶guard (Haskell pattern guard).
#[derive(Clone)]
pub struct AnchorPattern {
	pub name:    &'static str,
	/// Returns true if the given node matches this anchor.
	/// The matcher has access to the full source and node.
	pub matcher: fn(&Node<'_>, &str) -> bool,
}

impl std::fmt::Debug for AnchorPattern {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("AnchorPattern")
			.field("name", &self.name)
			.finish()
	}
}

// ── QualifierSpec ────────────────────────────────────────────────

/// Describes a qualifier available for this dialect.
#[derive(Clone)]
pub struct QualifierSpec {
	pub name:       &'static str,
	/// The node types this qualifier applies to.
	pub applies_to: Vec<String>,
	/// The resolver that produces the byte range.
	pub resolve:    Arc<dyn QualifierResolver>,
}

impl std::fmt::Debug for QualifierSpec {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("QualifierSpec")
			.field("name", &self.name)
			.finish()
	}
}

// ── EdgeKindSet ──────────────────────────────────────────────────

/// Which edge kinds this dialect supports.
/// Default: Ref, Def, Call, Import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeKindSet {
	pub kinds: HashSet<EdgeKind>,
}

impl Default for EdgeKindSet {
	fn default() -> Self {
		EdgeKindSet {
			kinds: HashSet::from([EdgeKind::Ref, EdgeKind::Def, EdgeKind::Call, EdgeKind::Import]),
		}
	}
}

pub type KindAliasMap = HashMap<String, Vec<String>>;

pub fn kind_aliases<const N: usize>(
	entries: [(&'static str, Vec<&'static str>); N],
) -> KindAliasMap {
	entries
		.into_iter()
		.map(|(alias, kinds)| (alias.to_string(), kinds.into_iter().map(str::to_string).collect()))
		.collect()
}

// ── LanguageDialect ──────────────────────────────────────────────

/// The complete dialect definition for one language.
/// Registered into LanguageProfile at construction time.
#[derive(Clone)]
pub struct LanguageDialect {
	pub name_lexer:   Arc<dyn NameLexer>,
	pub anchors:      Vec<AnchorPattern>,
	pub qualifiers:   Vec<QualifierSpec>,
	pub edge_kinds:   EdgeKindSet,
	/// BUG-413 (PLAN-318 W0): universal `§kind` alias → list of raw tree-sitter
	/// kinds for this dialect. Recipe `::§function` resolves cross-language
	/// via this map; raw kinds (e.g. `::§function_declaration` in TS) still
	/// work directly without going through this map.
	///
	/// Canonical alias set: `function`, `method`, `class`, `decl`, `call`,
	/// `import`, `binding`, `identifier`. Dialects may extend (e.g.
	/// Rust `trait`, Python `decorator`) or omit aliases they don't have.
	pub kind_aliases: KindAliasMap,
}

impl std::fmt::Debug for LanguageDialect {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("LanguageDialect")
			.field("anchors", &self.anchors.len())
			.field("qualifiers", &self.qualifiers.len())
			.field("edge_kinds", &self.edge_kinds)
			.finish()
	}
}
