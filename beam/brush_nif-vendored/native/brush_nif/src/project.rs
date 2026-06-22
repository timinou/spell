//! bash text <-> PTC-native tree (PLAN-011 W5 — the homoiconic completion).
//!
//! `parse` turns a bash string into a tree of `form_tree`-shaped nodes (the
//! same walkable shape `SpellAgent.Hist.Lens.form_tree/1` produces for Lisp),
//! so a shell pipeline and a Lisp program land in ONE recall layer. `unparse`
//! is the inverse, re-escaping words so a round-trip can never reintroduce
//! injection.
//!
//! # Node shape (mirrors form_tree)
//!
//! ```text
//! %{"node" => kind, "name"? => str, "value"? => str, "children"? => [node]}
//! ```
//!
//! Common bash (program / and-or / pipeline / simple command / word) is fully
//! structured. Every brush AST node implements `Display`, so any construct this
//! projector does not model structurally degrades to a SAFE, walkable
//! `{"node":"raw","value":"<source text>"}` leaf rather than failing — and that
//! verbatim text round-trips exactly.

use brush_parser::ast::{
	AndOr, Command, CommandPrefixOrSuffixItem, CompoundListItem, Pipeline, Program, SimpleCommand,
};
use rustler::{Encoder, Env, Term};

/// A projected node — the Rust mirror of a `form_tree` map. Encodes to an
/// Elixir string-keyed map (omitting absent optional fields).
pub enum Node {
	/// A leaf with a kind and a string value, e.g. a word or a `raw` fallback.
	Value { kind: &'static str, value: String },
	/// A named node with structural children, e.g. a command.
	Named { kind: &'static str, name: String, children: Vec<Node> },
	/// A node with only children, e.g. a pipeline or program.
	Branch { kind: &'static str, children: Vec<Node> },
}

impl Node {
	/// Encode to a string-keyed Elixir map matching the `form_tree` shape, with
	/// only the relevant optional fields present.
	pub fn encode<'a>(&self, env: Env<'a>) -> Term<'a> {
		match self {
			Node::Value { kind, value } => {
				Term::map_from_pairs(env, &[("node", kind.encode(env)), ("value", value.encode(env))])
					.expect("static keys")
			},
			Node::Named { kind, name, children } => {
				let kids: Vec<Term<'a>> = children.iter().map(|c| c.encode(env)).collect();
				Term::map_from_pairs(env, &[
					("node", kind.encode(env)),
					("name", name.encode(env)),
					("children", kids.encode(env)),
				])
				.expect("static keys")
			},
			Node::Branch { kind, children } => {
				let kids: Vec<Term<'a>> = children.iter().map(|c| c.encode(env)).collect();
				Term::map_from_pairs(env, &[("node", kind.encode(env)), ("children", kids.encode(env))])
					.expect("static keys")
			},
		}
	}
}

// ── parse: bash -> Node tree ──────────────────────────────────────────────

/// Parse a bash string into a projected [`Node`] tree. Returns `Err(msg)` only
/// on a genuine PARSE error (malformed bash); valid-but-exotic constructs never
/// error — they become `raw` leaves.
pub fn parse(src: &str) -> Result<Node, String> {
	let options = brush_parser::ParserOptions::default();
	let reader = std::io::BufReader::new(src.as_bytes());
	let source_info = brush_parser::SourceInfo { source: String::from("main") };
	let mut parser = brush_parser::Parser::new(reader, &options, &source_info);

	match parser.parse_program() {
		Ok(program) => Ok(project_program(&program)),
		Err(e) => Err(format!("parse error: {e}")),
	}
}

fn project_program(program: &Program) -> Node {
	let children = program
		.complete_commands
		.iter()
		.flat_map(|cmd| cmd.0.iter().map(project_list_item))
		.collect();
	Node::Branch { kind: "program", children }
}

fn project_list_item(item: &CompoundListItem) -> Node {
	// item.0 is an AndOrList (first pipeline + any && / || continuations).
	let and_or = &item.0;
	let first = project_pipeline(&and_or.first);

	if and_or.additional.is_empty() {
		first
	} else {
		let mut children = vec![first];
		for ao in &and_or.additional {
			children.push(project_and_or(ao));
		}
		Node::Branch { kind: "and_or", children }
	}
}

fn project_and_or(ao: &AndOr) -> Node {
	match ao {
		AndOr::And(p) => Node::Branch { kind: "and", children: vec![project_pipeline(p)] },
		AndOr::Or(p) => Node::Branch { kind: "or", children: vec![project_pipeline(p)] },
	}
}

fn project_pipeline(pipeline: &Pipeline) -> Node {
	let stages: Vec<Node> = pipeline.seq.iter().map(project_command).collect();
	// A single-stage pipeline is just its command — keep the tree shallow.
	if stages.len() == 1 {
		stages.into_iter().next().unwrap()
	} else {
		Node::Branch { kind: "pipeline", children: stages }
	}
}

fn project_command(command: &Command) -> Node {
	match command {
		Command::Simple(simple) => project_simple(simple),
		// Compound commands, function defs, extended tests: not modelled
		// structurally in v1 — preserve as a walkable `raw` leaf (Display gives
		// the exact source).
		other => Node::Value { kind: "raw", value: other.to_string() },
	}
}

fn project_simple(simple: &SimpleCommand) -> Node {
	// A PREFIX (leading `VAR=val` assignments or redirects) changes semantics and
	// its position relative to the name matters — `FOO=bar echo` is not
	// `echo FOO=bar`. The structured `command` node carries only name+suffix
	// words (the argv model), so a command WITH a prefix is preserved verbatim as
	// a `raw` leaf (Display renders the exact source) rather than risking a
	// semantics-changing round-trip.
	if simple.prefix.is_some() {
		return Node::Value { kind: "raw", value: simple.to_string() };
	}

	let name = simple
		.word_or_name
		.as_ref()
		.map(|w| unquote_word(&w.value))
		.unwrap_or_default();

	let mut children = Vec::new();
	if let Some(suffix) = &simple.suffix {
		for item in &suffix.0 {
			children.push(project_prefix_suffix(item));
		}
	}

	Node::Named { kind: "command", name, children }
}

fn project_prefix_suffix(item: &CommandPrefixOrSuffixItem) -> Node {
	match item {
		CommandPrefixOrSuffixItem::Word(w) => {
			Node::Value { kind: "word", value: unquote_word(&w.value) }
		},
		// Redirects, assignments, process substitutions: preserve verbatim.
		other => Node::Value { kind: "raw", value: other.to_string() },
	}
}

// ── unparse: Node tree -> bash ────────────────────────────────────────────

/// Render a projected tree back to a bash string. Words are re-escaped so a
/// round-trip can never reintroduce shell injection (a hand-built malicious
/// word stays one literal argument). `raw` leaves are emitted verbatim.
pub fn unparse(node: &UnparseNode) -> String {
	match node.kind.as_str() {
		"program" => node
			.children
			.iter()
			.map(unparse)
			.collect::<Vec<_>>()
			.join("; "),
		"pipeline" => node
			.children
			.iter()
			.map(unparse)
			.collect::<Vec<_>>()
			.join(" | "),
		"and_or" => unparse_and_or(node),
		"and" => format!("&& {}", join_children(node, " ")),
		"or" => format!("|| {}", join_children(node, " ")),
		"command" => unparse_command(node),
		"word" => crate::argv::shell_escape(&node.value),
		// `raw` (and any unknown kind) round-trips its preserved text verbatim.
		_ => node.value.clone(),
	}
}

fn unparse_and_or(node: &UnparseNode) -> String {
	// children: [first-pipeline, and/or, and/or, …]
	node
		.children
		.iter()
		.map(unparse)
		.collect::<Vec<_>>()
		.join(" ")
}

fn unparse_command(node: &UnparseNode) -> String {
	let mut parts = Vec::with_capacity(node.children.len() + 1);
	if !node.name.is_empty() {
		parts.push(crate::argv::shell_escape(&node.name));
	}
	for child in &node.children {
		parts.push(unparse(child));
	}
	parts.join(" ")
}

fn join_children(node: &UnparseNode, sep: &str) -> String {
	node
		.children
		.iter()
		.map(unparse)
		.collect::<Vec<_>>()
		.join(sep)
}

/// The decoded form of a `form_tree` node coming back from Elixir for unparse.
/// Mirrors [`Node`] but owns its strings (decoded from a BEAM map).
pub struct UnparseNode {
	pub kind:     String,
	pub name:     String,
	pub value:    String,
	pub children: Vec<UnparseNode>,
}

/// Maximum tree depth for decode/encode/unparse recursion. A NIF runs on a
/// scheduler thread whose stack a `catch_unwind` CANNOT protect (a Rust stack
/// overflow aborts the whole VM), so agent-supplied trees are hard-bounded
/// here. Well past any realistic shell AST; deeper input is truncated to a
/// `raw` marker leaf rather than growing the stack.
pub const MAX_DEPTH: usize = 256;

impl UnparseNode {
	/// Decode a `form_tree`-shaped Elixir map into an [`UnparseNode`]. Missing
	/// optional fields default to empty; a non-map term decodes to an empty
	/// `raw` node so `unparse` degrades safely rather than erroring. Recursion
	/// is depth-bounded (see [`MAX_DEPTH`]) so a maliciously nested tree from
	/// the agent cannot overflow the scheduler stack.
	pub fn decode(term: Term<'_>) -> Self {
		UnparseNode::decode_at(term, 0)
	}

	fn decode_at(term: Term<'_>, depth: usize) -> Self {
		let kind = map_get_str(term, "node").unwrap_or_else(|| "raw".to_string());
		let name = map_get_str(term, "name").unwrap_or_default();
		let value = map_get_str(term, "value").unwrap_or_default();

		// At the depth limit, stop recursing: drop children so the stack cannot
		// grow further. The truncated node still renders (as itself, minus the
		// over-deep subtree).
		let children = if depth >= MAX_DEPTH {
			Vec::new()
		} else {
			map_get(term, "children")
				.and_then(|t| t.decode::<Vec<Term<'_>>>().ok())
				.map(|ts| {
					ts.into_iter()
						.map(|t| UnparseNode::decode_at(t, depth + 1))
						.collect()
				})
				.unwrap_or_default()
		};

		UnparseNode { kind, name, value, children }
	}
}

fn map_get<'a>(term: Term<'a>, key: &str) -> Option<Term<'a>> {
	term.map_get(key.encode(term.get_env())).ok()
}

fn map_get_str(term: Term<'_>, key: &str) -> Option<String> {
	map_get(term, key).and_then(|t| t.decode::<String>().ok())
}

/// POSIX quote-removal for a parsed word's raw text -> its LOGICAL value,
/// WITHOUT expansion. The tree holds logical values so `parse -> unparse ->
/// parse` is idempotent: `unparse` re-escapes the logical value via
/// `shell_escape`, and this function inverts ANY quoting (including the
/// `'\''` run that `shell_escape` itself emits) back to the same logical value.
///
/// It is a single left-to-right pass over the raw word, concatenating the
/// content of single-quote runs (fully literal), double-quote runs (with the
/// inner `\" \\ \$ \`` escapes resolved), and bare runs (backslash escapes
/// the next char). This handles every form brush emits for an argv-style word,
/// notably `'a'\''b'` -> `a'b`, which the previous "fully-quoted-or-bail"
/// version mis-handled (breaking round-trip idempotency for words with quotes).
fn unquote_word(raw: &str) -> String {
	let mut out = String::with_capacity(raw.len());
	let mut chars = raw.chars().peekable();

	while let Some(&c) = chars.peek() {
		match c {
			'\'' => {
				chars.next(); // opening '
				for ch in chars.by_ref() {
					if ch == '\'' {
						break; // closing ' (single quotes have no escapes)
					}
					out.push(ch);
				}
			},
			'"' => {
				chars.next(); // opening "
				while let Some(ch) = chars.next() {
					match ch {
						'"' => break, // closing "
						'\\' => match chars.next() {
							// Only these are escapable inside double quotes.
							Some(n @ ('"' | '\\' | '$' | '`')) => out.push(n),
							Some(other) => {
								out.push('\\');
								out.push(other);
							},
							None => out.push('\\'),
						},
						other => out.push(other),
					}
				}
			},
			'\\' => {
				chars.next(); // the backslash
				if let Some(n) = chars.next() {
					out.push(n); // bare escape: next char is literal
				}
			},
			other => {
				out.push(other);
				chars.next();
			},
		}
	}

	out
}
