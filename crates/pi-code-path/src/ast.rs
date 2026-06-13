use std::{fmt, path::PathBuf};

use serde::{Deserialize, Serialize};

// ── Top-level CodePath ────────────────────────────────────────────

/// A complete CodePath expression: locator, query, optional qualifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CodePath {
	pub locator:   Locator,
	pub query:     Option<Query>,
	pub qualifier: Option<Qualifier>,
}

impl CodePath {
	/// True when the CodePath is a standalone Locator (e.g. find-style file
	/// query).
	pub fn is_standalone_locator(&self) -> bool {
		self.query.is_none() && self.qualifier.is_none()
	}

	/// True when the CodePath carries a query or qualifier, i.e. it is not a
	/// bare locator. Symbol resolvers use this to reject bare-path targets.
	pub fn has_target_query(&self) -> bool {
		self.query.is_some() || self.qualifier.is_some()
	}
}

// ── Locator ───────────────────────────────────────────────────────

/// The file or URI root of the CodePath.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Locator {
	/// Project-relative filesystem path (may contain glob segments).
	Fs(FsLocator),
	/// Internal URI (artifact://, memory://, etc.).
	Uri(UriLocator),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FsLocator {
	pub segments: Vec<FsSegment>,
}
impl FsLocator {
	/// True when the locator contains glob segments (Star, DoubleStar, Question,
	/// CharClass, or Brace).
	pub fn is_glob(&self) -> bool {
		self.segments.iter().any(|seg| {
			matches!(
				seg,
				FsSegment::Star
					| FsSegment::DoubleStar
					| FsSegment::Question
					| FsSegment::CharClass(_)
					| FsSegment::Brace { .. }
			)
		})
	}
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FsSegment {
	Literal(String),
	Star,
	DoubleStar,
	Question,
	CharClass(Vec<char>),
	Brace { items: Vec<String>, exclusions: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UriLocator {
	pub scheme: String,
	pub path:   String,
}

// ── Query ─────────────────────────────────────────────────────────

/// A query is a chain of steps joined by combinators.
/// The first step has no combinator; each subsequent step has one.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Query {
	pub head:  Step,
	pub chain: Vec<(Combinator, Step)>,
}

impl Query {
	pub fn single(step: Step) -> Self {
		Query { head: step, chain: Vec::new() }
	}

	/// All steps in order (head first, then chain).
	pub fn steps(&self) -> impl Iterator<Item = &Step> {
		std::iter::once(&self.head).chain(self.chain.iter().map(|(_, s)| s))
	}

	pub fn segments(&self) -> impl Iterator<Item = (Option<&Combinator>, &Step)> {
		std::iter::once((None, &self.head)).chain(self.chain.iter().map(|(c, s)| (Some(c), s)))
	}
}

// ── Step ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Step {
	pub axis:       Option<Axis>,
	pub head:       Head,
	pub predicates: Vec<Predicate>,
}

// ── Combinator ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Combinator {
	Child,
	Descendant,
	Parent,
	Ancestor,
	PrevSibling,
	NextSibling,
	/// Graph edge traversal (ref→, def→, call→, import→, bind→).
	Edge(EdgeKind),
	/// Set union A | B.
	Union,
	/// Set intersect A & B.
	Intersect,
	/// Set difference A - B.
	Except,
}

// ── Axis ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Axis {
	/// § — structural node-kind axis (tree-sitter node type).
	Structural,
	/// : — tree-sitter field axis.
	Field,
	/// ¶ — language-registered anchor axis.
	Anchor,
}

// ── Head ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Head {
	/// Dialect NamePayload (semantic/default axis — no sigil).
	Name(NamePayload),
	/// § NodeKind string (tree-sitter node type).
	NodeKind(String),
	/// : FieldName string.
	FieldName(String),
	/// ¶ AnchorName string.
	AnchorName(String),
	/// ( Query ) — grouping / subquery.
	Group(Box<Query>),
}

// ── NamePayload ───────────────────────────────────────────────────

/// Opaque to the kernel; each dialect parses and renders its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NamePayload {
	/// Generic fallback: raw string.
	Raw(String),
	/// Backtick-quoted verbatim text (allows spaces and special chars).
	Quoted(String),
}

// ── Predicate ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Predicate {
	/// [N] — ordinal index.
	Ordinal(isize),
	/// [a..b] — range slice (negatives allowed).
	Range { start: Option<isize>, end: Option<isize> },
	/// [§ NodeKind] — kind filter.
	KindFilter(String),
	/// [¶ AnchorName] — anchor filter.
	AnchorFilter(String),
	/// [. Q] — has-descendant subquery.
	HasDescendant(Box<Query>),
	/// [.^ Q] — has-ancestor subquery.
	HasAncestor(Box<Query>),
	/// [attr=value] — attribute equality (string value).
	Attribute { name: String, value: String },
	/// [text~="regex"] — text-pattern match.
	TextMatch(String),
	/// [match="literal"] — literal match.
	LiteralMatch(String),
	/// [name OP value] — comparison form (size>1M, mtime>2026-01-01, depth>=2,
	/// len>80, count>5). `value` is the raw textual right-hand side; resolvers
	/// normalise units (K/M/G/Ki/Mi/Gi) and date formats (RFC3339 /
	/// YYYY-MM-DD).
	Compare { name: String, op: CompareOp, value: String },
	/// [flag] — bare flag predicate ([empty], [multiline], [text]).
	Flag(String),
	/// [len OP N] — typed length comparison (kept for back-compat; new code uses
	/// Compare).
	Length { op: CompareOp, value: u64 },
	/// [count OP N] — typed count comparison (kept for back-compat; new code
	/// uses Compare).
	Count { kind: Option<String>, op: CompareOp, value: u64 },
	/// FEAT-718: trailing line-slice on a symbol step (`Bar.method:80-90`,
	/// `Bar.method:±5`, `Bar.method:-5..+10`). Sign-disambiguated:
	/// `relative=false` ⇒ absolute file lines (intersected with symbol span);
	/// `relative=true` ⇒ offsets applied to the symbol span boundaries.
	SymbolSlice { start: Option<i64>, end: Option<i64>, relative: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompareOp {
	Gt,
	Lt,
	Gte,
	Lte,
	Eq,
	Neq,
}

// ── Qualifier ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Qualifier {
	pub name: String,
	pub args: Option<String>,
}

// ── EdgeKind ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
	/// ref→ — follow a reference to its definition.
	Ref,
	/// def→ — from a declaration to its references (set-valued).
	Def,
	/// call→ — from a call site to the callee.
	Call,
	/// import→ — from an imported name to the source module.
	Import,
	/// bind→ — from a use to its binding site (scope-local).
	Bind,
	/// implements→ — PLAN-318 W2: from a type to the interface/trait it
	/// implements.
	Implements,
	/// inherits→ — PLAN-318 W2: from a type to its base type.
	Inherits,
	/// dispatches→ — PLAN-318 W2: from a polymorphic call site to candidate
	/// dispatch targets.
	Dispatches,
}

// ── NodeSet ───────────────────────────────────────────────────────

/// Result set from resolving a CodePath query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSet {
	pub nodes: Vec<PathBuf>,
}

impl NodeSet {
	pub fn union(&self, other: &NodeSet) -> NodeSet {
		let mut nodes = self.nodes.clone();
		for n in &other.nodes {
			if !nodes.contains(n) {
				nodes.push(n.clone());
			}
		}
		NodeSet { nodes }
	}

	pub fn intersect(&self, other: &NodeSet) -> NodeSet {
		let nodes: Vec<_> = self
			.nodes
			.iter()
			.filter(|n| other.nodes.contains(n))
			.cloned()
			.collect();
		NodeSet { nodes }
	}

	pub fn except(&self, other: &NodeSet) -> NodeSet {
		let nodes: Vec<_> = self
			.nodes
			.iter()
			.filter(|n| !other.nodes.contains(n))
			.cloned()
			.collect();
		NodeSet { nodes }
	}
}

// ── Display ───────────────────────────────────────────────────────

impl fmt::Display for EdgeKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			EdgeKind::Ref => write!(f, "ref→"),
			EdgeKind::Def => write!(f, "def→"),
			EdgeKind::Call => write!(f, "call→"),
			EdgeKind::Import => write!(f, "import→"),
			EdgeKind::Bind => write!(f, "bind→"),
			EdgeKind::Implements => write!(f, "implements→"),
			EdgeKind::Inherits => write!(f, "inherits→"),
			EdgeKind::Dispatches => write!(f, "dispatches→"),
		}
	}
}

impl fmt::Display for Combinator {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Combinator::Child => write!(f, "/"),
			Combinator::Descendant => write!(f, "//"),
			Combinator::Parent => write!(f, "^"),
			Combinator::Ancestor => write!(f, "^^"),
			Combinator::PrevSibling => write!(f, "<<"),
			Combinator::NextSibling => write!(f, ">>"),
			Combinator::Edge(kind) => write!(f, "{kind}"),
			Combinator::Union => write!(f, " | "),
			Combinator::Intersect => write!(f, " & "),
			Combinator::Except => write!(f, " - "),
		}
	}
}

impl fmt::Display for Axis {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Axis::Structural => write!(f, "§"),
			Axis::Field => write!(f, ":"),
			Axis::Anchor => write!(f, "¶"),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionContent {
	Single(String),
	Multi(Vec<String>),
}

impl ActionContent {
	pub fn join(&self, sep: &str) -> String {
		match self {
			Self::Single(s) => s.clone(),
			Self::Multi(v) => v.join(sep),
		}
	}

	pub fn lines(&self) -> Vec<String> {
		match self {
			Self::Single(s) => s.split('\n').map(String::from).collect(),
			Self::Multi(v) => v.clone(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Occurrence {
	First,
	Last,
	All,
	#[serde(untagged)]
	Index(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpliceMode {
	#[serde(rename = "self")]
	OnlySelf,
	Up,
	Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
	Up,
	Down,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutcome {
	#[serde(default)]
	pub edit_count:     u32,
	#[serde(default)]
	pub diff:           Option<String>,
	#[serde(default)]
	pub created:        bool,
	#[serde(default)]
	pub target_summary: Option<String>,
}
