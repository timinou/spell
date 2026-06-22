//! Inject-proofness oracle for the argv -> brush AST builder (PLAN-011 W0).
//!
//! These tests are the R1 evidence: they prove that NO argv element can trigger
//! shell behavior, by asserting on (a) the escaping function directly and (b)
//! the shape of the produced AST. Execution-level proof (that
//! `["echo","$(date)"]` prints the literal text) lives in the Elixir
//! `brush_nif_test.exs`, which can actually run a command; here we prove the
//! *construction* is sound.
//!
//! The crate is a `cdylib`, so we re-`include!` the unit under test rather than
//! importing it (a cdylib exposes no Rust-linkable surface).

#[path = "../src/argv.rs"]
mod argv;

use argv::{argv_to_program, pipeline_to_program, shell_escape};

// ── escaping ────────────────────────────────────────────────────────────

#[test]
fn escape_wraps_plain_word() {
	assert_eq!(shell_escape("abc"), "'abc'");
}

#[test]
fn escape_empty_is_empty_quotes() {
	// An empty argv element must survive as a real empty argument.
	assert_eq!(shell_escape(""), "''");
}

#[test]
fn escape_neutralizes_single_quote() {
	// The classic POSIX idiom: close, escaped-literal-quote, reopen.
	assert_eq!(shell_escape("a'b"), "'a'\\''b'");
}

#[test]
fn escape_keeps_metacharacters_literal() {
	// None of these expand or re-tokenize inside single quotes.
	for raw in ["$(date)", "${HOME}", "*", "~", "a;b", "a|b", "a&b", "`id`", "$x"] {
		let escaped = shell_escape(raw);
		assert!(escaped.starts_with('\''), "{raw} -> {escaped}");
		assert!(escaped.ends_with('\''), "{raw} -> {escaped}");
		// The raw text is present verbatim between the quotes (no quote inside
		// these cases, so it is a clean wrap).
		assert_eq!(escaped, format!("'{raw}'"));
	}
}

// ── AST shape ───────────────────────────────────────────────────────────

#[test]
fn empty_argv_yields_no_program() {
	assert!(argv_to_program(&[]).is_none());
}

#[test]
fn single_word_has_name_and_no_suffix() {
	let prog = argv_to_program(&["ls".to_string()]).unwrap();
	let simple = first_simple(&prog);
	let name = simple.word_or_name.as_ref().unwrap();
	assert_eq!(name.value, "'ls'");
	assert!(simple.suffix.is_none());
}

#[test]
fn args_become_escaped_suffix_words() {
	let argv = vec!["echo".to_string(), "; rm -rf /".to_string()];
	let prog = argv_to_program(&argv).unwrap();
	let simple = first_simple(&prog);
	assert_eq!(simple.word_or_name.as_ref().unwrap().value, "'echo'");
	let suffix = simple.suffix.as_ref().expect("one suffix word");
	assert_eq!(suffix.0.len(), 1);
	// The metacharacter-laden arg is ONE escaped word; `;` cannot split.
	match &suffix.0[0] {
		brush_parser::ast::CommandPrefixOrSuffixItem::Word(w) => {
			assert_eq!(w.value, "'; rm -rf /'");
		},
		other => panic!("expected a Word, got {other:?}"),
	}
}

#[test]
fn pipeline_has_one_stage_per_argv() {
	let stages = vec![
		vec!["cat".to_string(), "f".to_string()],
		vec!["grep".to_string(), "ERR".to_string()],
		vec!["wc".to_string(), "-l".to_string()],
	];
	let prog = pipeline_to_program(&stages).unwrap();
	let pipeline = &prog.complete_commands[0].0[0].0.first;
	assert_eq!(pipeline.seq.len(), 3);
}

#[test]
fn pipeline_rejects_empty_stage() {
	let stages = vec![vec!["cat".to_string()], vec![]];
	assert!(pipeline_to_program(&stages).is_none());
}

// ── helper ──────────────────────────────────────────────────────────────

fn first_simple(prog: &brush_parser::ast::Program) -> &brush_parser::ast::SimpleCommand {
	let pipeline = &prog.complete_commands[0].0[0].0.first;
	match &pipeline.seq[0] {
		brush_parser::ast::Command::Simple(s) => s,
		other => panic!("expected Simple, got {other:?}"),
	}
}
