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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FsSegment {
	Literal(String),
	Star,
	DoubleStar,
	Question,
	CharClass(Vec<char>),
	Brace(Vec<String>),
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
// ── Actions ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
	Create {
		content: ActionContent,
		#[serde(default)]
		force:   bool,
	},
	Write {
		content: ActionContent,
		#[serde(default)]
		force:   bool,
	},
	Delete,
	Append {
		lines: ActionContent,
	},
	Prepend {
		lines: ActionContent,
	},
	Insert {
		#[serde(default)]
		pos:   Option<String>,
		#[serde(default)]
		line:  Option<u32>,
		lines: ActionContent,
	},
	Replace {
		#[serde(default)]
		pos:   Option<String>,
		#[serde(default)]
		end:   Option<String>,
		#[serde(default)]
		line:  Option<u32>,
		#[serde(default)]
		lines: Option<ActionContent>,
	},
	Patch {
		diff: String,
	},
	Rename {
		content: String,
	},
	Wrap {
		content: ActionContent,
	},
	FindAndReplace {
		find:       ActionContent,
		content:    ActionContent,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},
	RawTextReplace {
		find:    ActionContent,
		content: ActionContent,
	},
	Splice {
		#[serde(default)]
		mode: Option<SpliceMode>,
	},
	Move {
		direction: Direction,
	},
	Clone {
		#[serde(default)]
		direction: Option<Direction>,
		#[serde(default)]
		line:      Option<u32>,
		#[serde(default)]
		content:   Option<ActionContent>,
	},
	Transpose {
		#[serde(default)]
		line:   Option<u32>,
		#[serde(default)]
		column: Option<u32>,
	},
	RenameClassToken {
		find:    String,
		content: String,
	},
	RenameIdToken {
		find:    String,
		content: String,
	},
	RenameCustomProperty {
		find:    String,
		content: String,
	},
	RemoveDeadStyle,
	Promote,
	Demote,
	ReplaceCodeBlock {
		content: ActionContent,
	},
	InsertBefore {
		lines: ActionContent,
	},
	InsertAfter {
		lines: ActionContent,
	},
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionKind {
	Create,
	Write,
	Delete,
	Append,
	Prepend,
	Insert,
	Replace,
	Patch,
	Rename,
	Wrap,
	FindAndReplace,
	RawTextReplace,
	Splice,
	Move,
	Clone,
	Transpose,
	RenameClassToken,
	RenameIdToken,
	RenameCustomProperty,
	RemoveDeadStyle,
	Promote,
	Demote,
	ReplaceCodeBlock,
	InsertBefore,
	InsertAfter,
}

impl Action {
	pub fn kind(&self) -> ActionKind {
		match self {
			Self::Create { .. } => ActionKind::Create,
			Self::Write { .. } => ActionKind::Write,
			Self::Delete => ActionKind::Delete,
			Self::Append { .. } => ActionKind::Append,
			Self::Prepend { .. } => ActionKind::Prepend,
			Self::Insert { .. } => ActionKind::Insert,
			Self::Replace { .. } => ActionKind::Replace,
			Self::Patch { .. } => ActionKind::Patch,
			Self::Rename { .. } => ActionKind::Rename,
			Self::Wrap { .. } => ActionKind::Wrap,
			Self::FindAndReplace { .. } => ActionKind::FindAndReplace,
			Self::RawTextReplace { .. } => ActionKind::RawTextReplace,
			Self::Splice { .. } => ActionKind::Splice,
			Self::Move { .. } => ActionKind::Move,
			Self::Clone { .. } => ActionKind::Clone,
			Self::Transpose { .. } => ActionKind::Transpose,
			Self::RenameClassToken { .. } => ActionKind::RenameClassToken,
			Self::RenameIdToken { .. } => ActionKind::RenameIdToken,
			Self::RenameCustomProperty { .. } => ActionKind::RenameCustomProperty,
			Self::RemoveDeadStyle => ActionKind::RemoveDeadStyle,
			Self::Promote => ActionKind::Promote,
			Self::Demote => ActionKind::Demote,
			Self::ReplaceCodeBlock { .. } => ActionKind::ReplaceCodeBlock,
			Self::InsertBefore { .. } => ActionKind::InsertBefore,
			Self::InsertAfter { .. } => ActionKind::InsertAfter,
		}
	}
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
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn action_create_serializes_correctly() {
		let a = Action::Create { content: ActionContent::Single("hi".into()), force: false };
		let v = serde_json::to_value(&a).unwrap();
		assert_eq!(v["kind"], "create");
		assert_eq!(v["content"], "hi");
		assert_eq!(v["force"], false);
	}

	#[test]
	fn action_roundtrip_create() {
		let a = Action::Create { content: ActionContent::Single("hi".into()), force: true };
		let json = serde_json::to_string(&a).unwrap();
		let b: Action = serde_json::from_str(&json).unwrap();
		assert_eq!(a, b);
	}

	#[test]
	fn action_roundtrip_replace_with_pos_and_lines() {
		let a = Action::Replace {
			pos:   Some("5#abc".into()),
			end:   None,
			line:  None,
			lines: Some(ActionContent::Multi(vec!["x".into()])),
		};
		let json = serde_json::to_string(&a).unwrap();
		let b: Action = serde_json::from_str(&json).unwrap();
		assert_eq!(a, b);
	}

	#[test]
	fn mutation_outcome_default_serializes_with_zero_edit_count() {
		let m = MutationOutcome::default();
		let v = serde_json::to_value(&m).unwrap();
		assert_eq!(v["editCount"], 0);
	}

	#[test]
	fn occurrence_index_roundtrips() {
		let o = Occurrence::Index(4);
		let json = serde_json::to_string(&o).unwrap();
		assert_eq!(json, "4");
		let back: Occurrence = serde_json::from_str(&json).unwrap();
		assert_eq!(o, back);
	}

	#[test]
	fn action_content_multi_roundtrips() {
		let c = ActionContent::Multi(vec!["a".into(), "b".into()]);
		let json = serde_json::to_string(&c).unwrap();
		let back: ActionContent = serde_json::from_str(&json).unwrap();
		assert_eq!(c, back);
	}

	#[test]
	fn action_kind_all_variants_reachable() {
		let actions = vec![
			Action::Create { content: ActionContent::Single("".into()), force: false },
			Action::Write { content: ActionContent::Single("".into()), force: false },
			Action::Delete,
			Action::Append { lines: ActionContent::Single("".into()) },
			Action::Prepend { lines: ActionContent::Single("".into()) },
			Action::Insert { pos: None, line: None, lines: ActionContent::Single("".into()) },
			Action::Replace { pos: None, end: None, line: None, lines: None },
			Action::Patch { diff: "".into() },
			Action::Rename { content: "".into() },
			Action::Wrap { content: ActionContent::Single("".into()) },
			Action::FindAndReplace {
				find:       ActionContent::Single("".into()),
				content:    ActionContent::Single("".into()),
				occurrence: None,
			},
			Action::RawTextReplace {
				find:    ActionContent::Single("".into()),
				content: ActionContent::Single("".into()),
			},
			Action::Splice { mode: None },
			Action::Move { direction: Direction::Up },
			Action::Clone { direction: None, line: None, content: None },
			Action::Transpose { line: None, column: None },
			Action::RenameClassToken { find: "".into(), content: "".into() },
			Action::RenameIdToken { find: "".into(), content: "".into() },
			Action::RenameCustomProperty { find: "".into(), content: "".into() },
			Action::RemoveDeadStyle,
			Action::Promote,
			Action::Demote,
			Action::ReplaceCodeBlock { content: ActionContent::Single("".into()) },
			Action::InsertBefore { lines: ActionContent::Single("".into()) },
			Action::InsertAfter { lines: ActionContent::Single("".into()) },
		];
		let kinds: Vec<ActionKind> = actions.iter().map(|a| a.kind()).collect();
		assert_eq!(kinds.len(), 25);
		// Ensure each ActionKind variant appears at least once.
		assert!(kinds.contains(&ActionKind::Create));
		assert!(kinds.contains(&ActionKind::Write));
		assert!(kinds.contains(&ActionKind::Delete));
		assert!(kinds.contains(&ActionKind::Append));
		assert!(kinds.contains(&ActionKind::Prepend));
		assert!(kinds.contains(&ActionKind::Insert));
		assert!(kinds.contains(&ActionKind::Replace));
		assert!(kinds.contains(&ActionKind::Patch));
		assert!(kinds.contains(&ActionKind::Rename));
		assert!(kinds.contains(&ActionKind::Wrap));
		assert!(kinds.contains(&ActionKind::FindAndReplace));
		assert!(kinds.contains(&ActionKind::RawTextReplace));
		assert!(kinds.contains(&ActionKind::Splice));
		assert!(kinds.contains(&ActionKind::Move));
		assert!(kinds.contains(&ActionKind::Clone));
		assert!(kinds.contains(&ActionKind::Transpose));
		assert!(kinds.contains(&ActionKind::RenameClassToken));
		assert!(kinds.contains(&ActionKind::RenameIdToken));
		assert!(kinds.contains(&ActionKind::RenameCustomProperty));
		assert!(kinds.contains(&ActionKind::RemoveDeadStyle));
		assert!(kinds.contains(&ActionKind::Promote));
		assert!(kinds.contains(&ActionKind::Demote));
		assert!(kinds.contains(&ActionKind::ReplaceCodeBlock));
		assert!(kinds.contains(&ActionKind::InsertBefore));
		assert!(kinds.contains(&ActionKind::InsertAfter));
	}
}
