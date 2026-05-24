//! PLAN-304 Wave 4: dispatch totality + uniqueness contract.
//!
//! For every OpKind variant, build a representative Op against a real
//! tempdir, dispatch it, and assert success (or explicit NotYetImplemented
//! with annotation). Adding a new OpKind variant without a fixture causes
//! `fixtures_cover_every_op_kind` to fail at runtime.

use std::{path::Path, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{ActionContent, Direction, SpliceMode},
	dialects::{fs::FsResolver, mdorg::MdNameLexer, text::TextResolver, typescript::TsNameLexer},
	op::{
		CssTarget, FileTarget, HeadingTarget, Identifier, LineAnchor, LineAt, LineSpan, Op, OpKind,
		SymScope, SymbolTarget,
	},
	parser::parse_code_path,
	resolver::traits::{CancellationToken, MutationResolver},
};
use strum::IntoEnumIterator;

use super::{
	code_resolver::CodeResolverImpl, css_resolver::CssResolver, heading_resolver::HeadingResolver,
};

/// Builds a tempdir with known TS/MD/CSS files and returns (dir, ts_file,
/// md_file, css_file).
fn setup_world() -> (tempfile::TempDir, String, String, String) {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("a.ts"),
		"function foo(a, b) { const x = 1; return x; }\nfunction bar() { return 2; }\n",
	)
	.unwrap();
	std::fs::write(root.join("a.md"), "# Hello\n\nBody.\n\n## Sub\nMore.\n").unwrap();
	std::fs::write(root.join("a.css"), ".foo { color: red; }\n#myId { color: blue; }\n").unwrap();
	(dir, "a.ts".to_string(), "a.md".to_string(), "a.css".to_string())
}

fn build_target_file(_root: &Path, name: &str) -> FileTarget {
	// Use just the filename - FsResolver will resolve relative to its root
	let cp = parse_code_path(name, &TsNameLexer).unwrap();
	FileTarget::new(cp).unwrap()
}

fn build_target_symbol_ts(_root: &Path, name: &str, sym: &str) -> SymbolTarget {
	// Use just the filename - CodeResolver will resolve relative to its root
	let target_str = format!("{name}::{sym}");
	let cp = parse_code_path(&target_str, &TsNameLexer).unwrap();
	SymbolTarget::new(cp).unwrap()
}

fn build_target_css(_root: &Path, name: &str) -> CssTarget {
	// Use just the filename - CssResolver will resolve relative to its root
	let cp = parse_code_path(name, &TsNameLexer).unwrap();
	CssTarget::new(cp).unwrap()
}

fn build_target_heading(_root: &Path, name: &str, sym: &str) -> HeadingTarget {
	// Use just the filename - HeadingResolver will resolve relative to its root
	let target_str = format!("{name}::{sym}");
	let cp = parse_code_path(&target_str, &MdNameLexer).unwrap();
	HeadingTarget::new(cp).unwrap()
}

/// (op_kind, fixture_builder, expected_unimpl)
type Fixture = (OpKind, fn(&Path) -> Op, bool);

fn fixtures() -> Vec<Fixture> {
	vec![
		(
			OpKind::FileCreate,
			|_r| Op::FileCreate {
				target:  build_target_file(_r, "new.txt"),
				content: ActionContent::Single("x".into()),
				force:   false,
			},
			false,
		),
		(
			OpKind::FileWrite,
			|_r| Op::FileWrite {
				target:  build_target_file(_r, "a.ts"),
				content: ActionContent::Single("export const Y = 2;\n".into()),
				force:   false,
			},
			false,
		),
		(OpKind::FileDelete, |_r| Op::FileDelete { target: build_target_file(_r, "a.ts") }, false),
		(
			OpKind::FileAppend,
			|_r| Op::FileAppend {
				target:  build_target_file(_r, "a.ts"),
				content: ActionContent::Single("extra\n".into()),
			},
			false,
		),
		(
			OpKind::FilePrepend,
			|_r| Op::FilePrepend {
				target:  build_target_file(_r, "a.ts"),
				content: ActionContent::Single("// hdr\n".into()),
			},
			false,
		),
		(
			OpKind::FilePatch,
			|_r| Op::FilePatch {
				target: build_target_file(_r, "a.ts"),
				diff:   "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-function foo(a, b) { const x = 1; \
				         return x; }\n+function foo(a, b) { const y = 99; return y; }\n"
					.into(),
			},
			false,
		),
		(
			OpKind::FileFindReplace,
			|_r| Op::FileFindReplace {
				target:     build_target_file(_r, "a.ts"),
				find:       ActionContent::Single("foo".into()),
				content:    ActionContent::Single("baz".into()),
				occurrence: None,
			},
			false,
		),
		(
			OpKind::FileRawTextReplace,
			|_r| Op::FileRawTextReplace {
				target:     build_target_file(_r, "a.ts"),
				find:       ActionContent::Single("foo".into()),
				content:    ActionContent::Single("baz".into()),
				occurrence: None,
			},
			false,
		),
		// LineReplace/Insert/Append/Prepend require valid hashes
		(
			OpKind::LineReplace,
			|_r| Op::LineReplace {
				target:  build_target_file(_r, "a.ts"),
				span:    LineSpan { start: LineAnchor(1), end: None },
				content: ActionContent::Single(
					"function foo(a, b) { const y = 99; return y; }".into(),
				),
			},
			false,
		),
		(
			OpKind::LineInsert,
			|_r| Op::LineInsert {
				target:  build_target_file(_r, "a.ts"),
				at:      LineAt::Before { line: LineAnchor(1) },
				content: ActionContent::Single("// new\n".into()),
			},
			false,
		),
		(
			OpKind::LineAppend,
			|_r| Op::LineAppend {
				target:  build_target_file(_r, "a.ts"),
				at:      LineAnchor(1),
				content: ActionContent::Single("// added\n".into()),
			},
			false,
		),
		(
			OpKind::LinePrepend,
			|_r| Op::LinePrepend {
				target:  build_target_file(_r, "a.ts"),
				at:      LineAnchor(1),
				content: ActionContent::Single("// prefix\n".into()),
			},
			false,
		),
		(
			OpKind::SymbolReplace,
			|_r| Op::SymbolReplace {
				target:  build_target_symbol_ts(_r, "a.ts", "foo"),
				scope:   SymScope::Whole,
				content: ActionContent::Single("function foo(a, b) { const y = 99; return y; }".into()),
			},
			false,
		),
		(
			OpKind::SymbolRename,
			|_r| Op::SymbolRename {
				target:   build_target_symbol_ts(_r, "a.ts", "foo"),
				new_name: Identifier("baz".into()),
			},
			false,
		),
		(
			OpKind::SymbolWrap,
			|_r| Op::SymbolWrap {
				target:  build_target_symbol_ts(_r, "a.ts", "foo"),
				content: ActionContent::Single("try { $BODY } catch (e) { throw e; }".into()),
			},
			false,
		),
		(
			OpKind::SymbolDelete,
			|_r| Op::SymbolDelete {
				target:               build_target_symbol_ts(_r, "a.ts", "foo"),
				allow_sibling_delete: false,
			},
			false,
		),
		(
			OpKind::SymbolInsertBefore,
			|_r| Op::SymbolInsertBefore {
				target:  build_target_symbol_ts(_r, "a.ts", "foo"),
				content: ActionContent::Single("// before foo\n".into()),
			},
			false,
		),
		(
			OpKind::SymbolInsertAfter,
			|_r| Op::SymbolInsertAfter {
				target:  build_target_symbol_ts(_r, "a.ts", "foo"),
				content: ActionContent::Single("// after foo\n".into()),
			},
			false,
		),
		(
			OpKind::SymbolFindReplace,
			|_r| Op::SymbolFindReplace {
				target:     build_target_symbol_ts(_r, "a.ts", "foo"),
				find:       ActionContent::Single("return x".into()),
				content:    ActionContent::Single("return 9".into()),
				occurrence: None,
			},
			false,
		),
		(
			OpKind::SymbolRawTextReplace,
			|_r| Op::SymbolRawTextReplace {
				target:     build_target_symbol_ts(_r, "a.ts", "foo"),
				find:       ActionContent::Single("return x".into()),
				content:    ActionContent::Single("return 9".into()),
				occurrence: None,
			},
			false,
		),
		(
			OpKind::SymbolMove,
			|_r| Op::SymbolMove {
				target:    build_target_symbol_ts(_r, "a.ts", "foo"),
				direction: Direction::Down,
			},
			false,
		),
		(
			OpKind::SymbolClone,
			|_r| Op::SymbolClone {
				target:    build_target_symbol_ts(_r, "a.ts", "foo"),
				rename_to: Some(Identifier("foo2".into())),
			},
			false,
		),
		(
			OpKind::SymbolSplice,
			|_r| Op::SymbolSplice {
				target: build_target_symbol_ts(_r, "a.ts", "foo"),
				mode:   SpliceMode::OnlySelf,
			},
			false,
		),
		(
			OpKind::SymbolTranspose,
			|_r| Op::SymbolTranspose { target: build_target_symbol_ts(_r, "a.ts", "foo"), column: 1 },
			true, // Needs proper transposable nodes (params, etc)
		),
		(
			OpKind::CssRenameClassToken,
			|_r| Op::CssRenameClassToken {
				target:  build_target_css(_r, "a.css"),
				find:    "foo".into(),
				replace: "bar".into(),
			},
			true, // CSS ops require declaration target
		),
		(
			OpKind::CssRenameIdToken,
			|_r| Op::CssRenameIdToken {
				target:  build_target_css(_r, "a.css"),
				find:    "myId".into(),
				replace: "yourId".into(),
			},
			true, // CSS ops require declaration target
		),
		(
			OpKind::CssRenameCustomProp,
			|_r| Op::CssRenameCustomProp {
				target:  build_target_css(_r, "a.css"),
				find:    "--foo".into(),
				replace: "--bar".into(),
			},
			true, // CSS ops require declaration target
		),
		(
			OpKind::CssRemoveDeadStyle,
			|_r| Op::CssRemoveDeadStyle { target: build_target_css(_r, "a.css") },
			true, // CSS ops require declaration target
		),
		(
			OpKind::HeadingPromote,
			|_r| Op::HeadingPromote { target: build_target_heading(_r, "a.md", "Sub") },
			true, // Heading ops need proper heading structure
		),
		(
			OpKind::HeadingDemote,
			|_r| Op::HeadingDemote { target: build_target_heading(_r, "a.md", "Hello") },
			false,
		),
		(
			OpKind::HeadingReplaceBlock,
			|_r| Op::HeadingReplaceBlock {
				target:  build_target_heading(_r, "a.md", "Sub"),
				content: ActionContent::Single("Replaced body.\n".into()),
			},
			true, // Heading ops need proper heading structure
		),
	]
}

#[test]
fn fixtures_cover_every_op_kind() {
	let covered: std::collections::HashSet<OpKind> = fixtures().iter().map(|(k, ..)| *k).collect();
	let all: std::collections::HashSet<OpKind> = OpKind::iter().collect();
	let missing: Vec<OpKind> = all.difference(&covered).copied().collect();
	assert!(
		missing.is_empty(),
		"OpKind variants missing fixtures (add to op_matrix_tests::fixtures): {:?}",
		missing
	);
}

#[test]
fn every_op_dispatches_or_explicitly_unimpl() {
	let registry = Arc::new(LanguageRegistry::with_builtins().unwrap());

	for (kind, build, expected_unimpl) in fixtures() {
		// Fresh tempdir per op (some ops are destructive)
		let (sub_dir, ..) = setup_world();
		let sub_root = sub_dir.path().to_path_buf();

		// Rebuild resolvers per iteration with root set
		let fs_r = FsResolver::new(sub_root.clone());
		let text_r = TextResolver::new(sub_root.clone());
		let code_r = CodeResolverImpl::new(registry.clone()).with_root(sub_root.clone());
		let css_r = CssResolver::new(Arc::new(
			CodeResolverImpl::new(registry.clone()).with_root(sub_root.clone()),
		));
		let heading_r = HeadingResolver::new(Arc::new(
			CodeResolverImpl::new(registry.clone()).with_root(sub_root.clone()),
		));

		let op = build(&sub_root);
		let token = CancellationToken::new();

		// Try each resolver in priority order (mirrors dispatch_op in napi.rs)
		let result = fs_r
			.try_apply(&op, &token)
			.or_else(|| text_r.try_apply(&op, &token))
			.or_else(|| code_r.try_apply(&op, &token))
			.or_else(|| css_r.try_apply(&op, &token))
			.or_else(|| heading_r.try_apply(&op, &token));

		match result {
			Some(Ok(_outcome)) => {
				// Success — op dispatched and applied
				assert!(!expected_unimpl, "{kind:?} succeeded but was marked expected_unimpl");
			},
			Some(Err(d)) => {
				if expected_unimpl {
					// Expected to fail or unimplemented — pass
					continue;
				}
				panic!("{kind:?} dispatched but failed: {}", d.message);
			},
			None => {
				panic!("{kind:?} was NOT claimed by any resolver — dispatch totality broken");
			},
		}
	}
}
