//! Property test: the inject-proof invariant holds for ARBITRARY argv (PLAN-011
//! W0).
//!
//! Invariant: for any vector of argument strings, `argv_to_program` produces
//! exactly ONE command whose word count equals the argv length. No element —
//! however full of `;`, `|`, `$()`, `*`, quotes, or newlines — ever splits into
//! an extra command or an extra word. This is the structural guarantee behind
//! "argv is delivered verbatim, like execve".

// argv.rs is `#[path]`-included as its own module here; this test exercises
// `argv_to_program` only, so the sibling `pipeline_to_program` is unused in
// this compilation unit (it is covered in argv_inject_proof.rs and the Elixir
// suite).
#[path = "../src/argv.rs"]
#[allow(dead_code)]
mod argv;

use argv::argv_to_program;
use brush_parser::ast::{Command, CommandPrefixOrSuffixItem};
use proptest::prelude::*;

proptest! {
	#![proptest_config(ProptestConfig::with_cases(512))]

	#[test]
	fn argv_length_is_preserved_as_word_count(
		argv in prop::collection::vec(any::<String>(), 1..8)
	) {
		let prog = argv_to_program(&argv).expect("non-empty argv builds a program");

		// Exactly one complete command, one and-or list, one pipeline, one stage.
		prop_assert_eq!(prog.complete_commands.len(), 1);
		let compound = &prog.complete_commands[0];
		prop_assert_eq!(compound.0.len(), 1);
		let pipeline = &compound.0[0].0.first;
		prop_assert_eq!(pipeline.seq.len(), 1, "no element may spawn a second command");

		let Command::Simple(simple) = &pipeline.seq[0] else {
			return Err(TestCaseError::fail("expected a simple command"));
		};

		// word_count = name (1) + suffix words. Must equal argv length exactly.
		let suffix_words = simple
			.suffix
			.as_ref()
			.map(|s| {
				s.0.iter()
					.filter(|i| matches!(i, CommandPrefixOrSuffixItem::Word(_)))
					.count()
			})
			.unwrap_or(0);
		let word_count = 1 + suffix_words;
		prop_assert_eq!(word_count, argv.len(), "every argv element is exactly one word");
	}

	#[test]
	fn every_word_is_single_quoted(
		argv in prop::collection::vec(any::<String>(), 1..8)
	) {
		let prog = argv_to_program(&argv).unwrap();
		let Command::Simple(simple) = &prog.complete_commands[0].0[0].0.first.seq[0] else {
			return Err(TestCaseError::fail("expected simple"));
		};
		// The name word is single-quoted (expansion-neutralized).
		let name = simple.word_or_name.as_ref().unwrap();
		prop_assert!(name.value.starts_with('\''));
		prop_assert!(name.value.ends_with('\''));
		// Every suffix word likewise.
		if let Some(suffix) = &simple.suffix {
			for item in &suffix.0 {
				if let CommandPrefixOrSuffixItem::Word(w) = item {
					prop_assert!(w.value.starts_with('\''), "word not quoted: {:?}", w.value);
					prop_assert!(w.value.ends_with('\''), "word not quoted: {:?}", w.value);
				}
			}
		}
	}
}
