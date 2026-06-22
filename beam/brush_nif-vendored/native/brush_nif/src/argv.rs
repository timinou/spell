//! argv → brush AST `Program`, INJECT-PROOF by construction (PLAN-011 W0).
//!
//! # The threat and the fix
//!
//! Running a command from an argv vector must NOT let any element trigger shell
//! behavior. Two distinct attack surfaces exist in brush, and we close both:
//!
//! 1. **Re-tokenization** (`;`, `|`, `&`, newlines). Avoided because we build a
//!    [`Program`] AST *directly* and hand it to `Shell::run_program`, never to
//!    the string parser. A metacharacter inside a [`Word`] value is just bytes
//!    in that word; it cannot split into a new command.
//!
//! 2. **Expansion** (`$(...)`, `${...}`, `*`, `~`, `` ` ``). brush expands each
//!    [`Word`] at *execution* time (`brush_core::expansion`), so a bare `Word {
//!    value: "$(date)" }` WOULD still run `date`. We neutralize this by
//!    **single-quote-escaping every element**: inside `'...'` brush performs no
//!    expansion at all. The escaping reproduces the well-known POSIX idiom (`'`
//!    becomes `'\''`), matching the existing `shell_escape` in
//!    `pi-natives/src/exec/scheme_preprocessor.rs`.
//!
//! The result: an argv element is delivered to the spawned process verbatim,
//! exactly one element, with zero shell interpretation. This is the same
//! guarantee `execve` gives — which is the entire point.

use brush_parser::ast::{
	AndOrList, Command, CommandPrefixOrSuffixItem, CommandSuffix, CompoundList, CompoundListItem,
	Pipeline, Program, SeparatorOperator, SimpleCommand, Word,
};

/// Single-quote-escape one argv element so brush applies NO expansion to it.
///
/// `abc`      -> `'abc'`
/// `a'b`      -> `'a'\''b'`   (close quote, escaped literal quote, reopen)
/// empty      -> `''`         (a real empty argument, not a dropped one)
///
/// Kept deliberately identical in behavior to the kernel's `shell_escape`.
pub fn shell_escape(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 2);
	out.push('\'');
	for ch in s.chars() {
		if ch == '\'' {
			out.push_str("'\\''");
		} else {
			out.push(ch);
		}
	}
	out.push('\'');
	out
}

/// Build a [`Word`] whose value is the escaped form of `raw`.
fn escaped_word(raw: &str) -> Word {
	Word { value: shell_escape(raw), loc: None }
}

/// Build a single-`SimpleCommand` [`Program`] from an argv vector.
///
/// `argv[0]` becomes the command name; the rest become suffix words. Every
/// element is escaped (see module docs). An empty argv yields `None` — there is
/// no command to run, and the caller (the NIF / the `sh` builtin) surfaces that
/// as a validation error rather than executing an empty program.
pub fn argv_to_program(argv: &[String]) -> Option<Program> {
	let (name, rest) = argv.split_first()?;

	let suffix = if rest.is_empty() {
		None
	} else {
		let items = rest
			.iter()
			.map(|arg| CommandPrefixOrSuffixItem::Word(escaped_word(arg)))
			.collect::<Vec<_>>();
		Some(CommandSuffix(items))
	};

	let simple = SimpleCommand { prefix: None, word_or_name: Some(escaped_word(name)), suffix };

	Some(wrap_simple(simple))
}

/// Build an N-stage pipeline [`Program`] (`a | b | c`) from N argv vectors.
///
/// Each stage is escaped independently; the only structural connection between
/// stages is brush's own stdout->stdin plumbing. A stage with an empty argv is
/// rejected by returning `None` (same contract as [`argv_to_program`]).
///
/// Wired into the `pipe` NIF (PLAN-011 W4); the inject-proof escaping lives in
/// ONE place for both the single-command and pipeline paths.
pub fn pipeline_to_program(stages: &[Vec<String>]) -> Option<Program> {
	if stages.is_empty() {
		return None;
	}

	let mut seq = Vec::with_capacity(stages.len());
	for stage in stages {
		let (name, rest) = stage.split_first()?;
		let suffix = if rest.is_empty() {
			None
		} else {
			Some(CommandSuffix(
				rest
					.iter()
					.map(|arg| CommandPrefixOrSuffixItem::Word(escaped_word(arg)))
					.collect(),
			))
		};
		seq.push(Command::Simple(SimpleCommand {
			prefix: None,
			word_or_name: Some(escaped_word(name)),
			suffix,
		}));
	}

	Some(wrap_pipeline(Pipeline { timed: None, bang: false, seq }))
}

/// Wrap one [`SimpleCommand`] in the full Program nesting brush expects.
fn wrap_simple(simple: SimpleCommand) -> Program {
	wrap_pipeline(Pipeline { timed: None, bang: false, seq: vec![Command::Simple(simple)] })
}

/// Wrap a [`Pipeline`] up through `AndOrList -> CompoundList -> CompleteCommand
/// -> Program`. This is the minimal valid spine for a single foreground
/// command/pipeline with no `&&`/`||`/`;` continuation.
fn wrap_pipeline(pipeline: Pipeline) -> Program {
	let and_or = AndOrList { first: pipeline, additional: Vec::new() };
	let item = CompoundListItem(and_or, SeparatorOperator::Sequence);
	// `CompleteCommand` is a type alias for `CompoundList` in brush-parser 0.3.
	let complete = CompoundList(vec![item]);
	Program { complete_commands: vec![complete] }
}
