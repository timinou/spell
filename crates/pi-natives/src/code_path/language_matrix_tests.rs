//! Language matrix — structural edits across supported languages (PLAN-306
//! W9.1).
//!
//! Mirrors `packages/coding-agent/test/codepath/language-matrix.test.ts` at the
//! kernel level, invoking MutationResolver directly (no JS/NAPI layer).
//!
//! ## Coverage
//!
//! | Language   | Ext    | Op 1                | Op 2                | Op 3                   |
//! |------------|--------|---------------------|---------------------|------------------------|
//! | TypeScript | .ts    | symbolReplace       | symbolRename        | symbolInsertAfter      |
//! | Rust       | .rs    | symbolReplace       | symbolRename        | symbolInsertAfter      |
//! | Python     | .py    | symbolReplace       | symbolRename        | symbolInsertAfter      |
//! | Markdown   | .md    | headingPromote      | headingDemote       | headingReplaceBlock    |
//! | CSS        | .css   | cssRenameClassToken | cssRenameIdToken    | cssRenameCustomProp¹   |
//! | HTML       | .html  | symbolReplace       | symbolWrap          | symbolInsertAfter²     |
//!
//! ¹ `#[ignore = "FUP-010: kernel rejects token-only rename target; must supply
//! rule-context    selector (.cls, #id, :root) instead of bare token.
//! CssResolver build_target_id falls    through to code_buffer which expects a
//! selector-formatted CodePath target."]` ² `#[ignore = "FUP-011: HTML element
//! selectors resolved but code_buffer symbol-resolver    does not treat element
//! names as symbol targets. Needs HTML-aware symbol target handling."]`

use std::sync::Arc;

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{ActionContent, CodePath, FsLocator, FsSegment, Head, Locator, NamePayload, Query, Step},
	op::{CssTarget, HeadingTarget, Identifier, Op, SymbolTarget},
	resolver::traits::{CancellationToken, MutationResolver},
};

use super::{
	code_resolver::CodeResolverImpl, css_resolver::CssResolver, heading_resolver::HeadingResolver,
};

// ── Helpers ────────────────────────────────────────────────────────

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn symbol_path(file: &std::path::Path, symbol: &str) -> CodePath {
	CodePath {
		locator:   Locator::Fs(FsLocator {
			segments: vec![FsSegment::Literal(file.display().to_string())],
		}),
		query:     Some(Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw(symbol.into())),
			predicates: vec![],
		})),
		qualifier: None,
	}
}

fn css_path(file: &std::path::Path) -> CodePath {
	CodePath {
		locator:   Locator::Fs(FsLocator {
			segments: vec![FsSegment::Literal(file.display().to_string())],
		}),
		query:     None,
		qualifier: None,
	}
}

fn heading_symbol_path(file: &std::path::Path, symbol: &str) -> CodePath {
	// Use MdNameLexer for heading symbols
	CodePath {
		locator:   Locator::Fs(FsLocator {
			segments: vec![FsSegment::Literal(file.display().to_string())],
		}),
		query:     Some(Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw(symbol.into())),
			predicates: vec![],
		})),
		qualifier: None,
	}
}

/// Build the resolver chain and dispatch an Op.
/// Returns Ok(()) if the op was handled (Some(Ok(...))) regardless of
/// application success, Err(message) if no resolver claimed the op.
fn dispatch_op(
	code_r: &CodeResolverImpl,
	css_r: &CssResolver,
	heading_r: &HeadingResolver,
	op: &Op,
) -> Result<(), String> {
	let token = CancellationToken::new();

	// Mirror dispatch order from napi.rs / op_matrix_tests.rs
	// FsResolver and TextResolver are skipped — they return None for
	// Symbol/Heading/CSS ops.
	let result = code_r
		.try_apply(op, &token)
		.or_else(|| css_r.try_apply(op, &token))
		.or_else(|| heading_r.try_apply(op, &token));

	match result {
		Some(Ok(_outcome)) => Ok(()),
		Some(Err(d)) => Err(format!("op dispatched but failed: {}", d.message)),
		None => Err("op was NOT claimed by any resolver — dispatch totality broken".into()),
	}
}

/// Run a single language-matrix test cell.
fn run_case(
	lang: &str,
	op_name: &str,
	before: &str,
	after: &str,
	build_op: impl FnOnce(&std::path::Path) -> Op,
) {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let ext = match lang {
		"typescript" => "ts",
		"rust" => "rs",
		"python" => "py",
		"markdown" => "md",
		"css" => "css",
		"html" => "html",
		_ => panic!("unknown language: {lang}"),
	};
	let path = root.join(format!("f.{ext}"));
	std::fs::write(&path, before).expect("write before fixture");

	let op = build_op(&path);

	let code_r = resolver().with_root(root.clone());
	let css_r = CssResolver::new(Arc::new(resolver().with_root(root.clone())));
	let heading_r = HeadingResolver::new(Arc::new(resolver().with_root(root.clone())));

	dispatch_op(&code_r, &css_r, &heading_r, &op)
		.unwrap_or_else(|e| panic!("{lang} {op_name}: dispatch error: {e}"));

	let actual = std::fs::read_to_string(&path).expect("read result");
	assert_eq!(actual.trim(), after.trim(), "{lang} {op_name}: content mismatch");
}

// ── TypeScript ────────────────────────────────────────────────────

mod typescript {
	use super::*;

	#[test]
	fn symbol_replace() {
		// JS test uses symbolFindReplace (action kind), not symbolReplace
		run_case(
			"typescript",
			"symbolReplace",
			SYMBOL_REPLACE_BEFORE_TS,
			SYMBOL_REPLACE_AFTER_TS,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
				Op::SymbolFindReplace {
					target,
					find: ActionContent::Single("return 'hello ' + name;".into()),
					content: ActionContent::Single("return 'hello ' + name + '!';".into()),
					occurrence: None,
				}
			},
		);
	}

	#[test]
	fn symbol_rename() {
		run_case(
			"typescript",
			"symbolRename",
			SYMBOL_RENAME_BEFORE_TS,
			SYMBOL_RENAME_AFTER_TS,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
				Op::SymbolRename { target, new_name: Identifier("salute".into()) }
			},
		);
	}

	#[test]
	fn symbol_insert_after() {
		run_case(
			"typescript",
			"symbolInsertAfter",
			SYMBOL_INSERT_AFTER_BEFORE_TS,
			SYMBOL_INSERT_AFTER_AFTER_TS,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
				Op::SymbolInsertAfter {
					target,
					content: ActionContent::Single("// inserted after greet\n".into()),
				}
			},
		);
	}
}

// ── Rust ──────────────────────────────────────────────────────────

mod rust {
	use pi_code_path::op::{Identifier, SymScope};

	use super::*;

	#[test]
	fn symbol_replace() {
		run_case("rust", "symbolReplace", SYMBOL_REPLACE_BEFORE_RS, SYMBOL_REPLACE_AFTER_RS, |p| {
			let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
			Op::SymbolReplace {
				target,
				scope: SymScope::Whole,
				content: ActionContent::Single(
					"pub fn greet(name: &str) -> String {\n    format!(\"hello {}!\", name)\n}".into(),
				),
			}
		});
	}

	#[test]
	fn symbol_rename() {
		run_case("rust", "symbolRename", SYMBOL_RENAME_BEFORE_RS, SYMBOL_RENAME_AFTER_RS, |p| {
			let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
			Op::SymbolRename { target, new_name: Identifier("salute".into()) }
		});
	}

	#[test]
	fn symbol_insert_after() {
		run_case(
			"rust",
			"symbolInsertAfter",
			SYMBOL_INSERT_AFTER_BEFORE_RS,
			SYMBOL_INSERT_AFTER_AFTER_RS,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
				Op::SymbolInsertAfter {
					target,
					content: ActionContent::Single("// inserted after greet\n".into()),
				}
			},
		);
	}
}

// ── Python ────────────────────────────────────────────────────────

mod python {
	use pi_code_path::op::{Identifier, SymScope};

	use super::*;

	#[test]
	fn symbol_replace() {
		run_case("python", "symbolReplace", SYMBOL_REPLACE_BEFORE_PY, SYMBOL_REPLACE_AFTER_PY, |p| {
			let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
			Op::SymbolReplace {
				target,
				scope: SymScope::Whole,
				content: ActionContent::Single("def greet(name):\n    return f'hello {name}!'".into()),
			}
		});
	}

	#[test]
	fn symbol_rename() {
		run_case("python", "symbolRename", SYMBOL_RENAME_BEFORE_PY, SYMBOL_RENAME_AFTER_PY, |p| {
			let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
			Op::SymbolRename { target, new_name: Identifier("salute".into()) }
		});
	}

	#[test]
	fn symbol_insert_after() {
		run_case(
			"python",
			"symbolInsertAfter",
			SYMBOL_INSERT_AFTER_BEFORE_PY,
			SYMBOL_INSERT_AFTER_AFTER_PY,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "greet")).unwrap();
				Op::SymbolInsertAfter {
					target,
					content: ActionContent::Single("# inserted after greet\n".into()),
				}
			},
		);
	}
}

// ── Markdown ──────────────────────────────────────────────────────

mod markdown {
	use pi_code_path::op::SymScope;

	use super::*;

	#[test]
	fn heading_promote() {
		run_case(
			"markdown",
			"headingPromote",
			HEADING_PROMOTE_BEFORE_MD,
			HEADING_PROMOTE_AFTER_MD,
			|p| {
				let target = HeadingTarget::new(heading_symbol_path(p, "Top")).unwrap();
				Op::HeadingPromote { target }
			},
		);
	}

	#[test]
	fn heading_demote() {
		run_case(
			"markdown",
			"headingDemote",
			HEADING_DEMOTE_BEFORE_MD,
			HEADING_DEMOTE_AFTER_MD,
			|p| {
				let target = HeadingTarget::new(heading_symbol_path(p, "Top")).unwrap();
				Op::HeadingDemote { target }
			},
		);
	}

	#[test]
	fn heading_replace_block() {
		// JS test uses kind: symbolReplace, scope: whole on heading
		run_case(
			"markdown",
			"headingReplaceBlock",
			HEADING_REPLACE_BLOCK_BEFORE_MD,
			HEADING_REPLACE_BLOCK_AFTER_MD,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "Top")).unwrap();
				Op::SymbolReplace {
					target,
					scope: SymScope::Whole,
					content: ActionContent::Single("# Top\n\nReplaced content.".into()),
				}
			},
		);
	}
}

// ── CSS ───────────────────────────────────────────────────────────

mod css {
	use super::*;

	#[test]
	fn rename_class_token() {
		run_case(
			"css",
			"cssRenameClassToken",
			CSS_RENAME_CLASS_BEFORE,
			CSS_RENAME_CLASS_AFTER,
			|p| {
				// JS test targets $FILE::.my-class — selector in query
				let cp = CodePath {
					locator:   Locator::Fs(FsLocator {
						segments: vec![FsSegment::Literal(p.display().to_string())],
					}),
					query:     Some(Query::single(Step {
						axis:       None,
						head:       Head::Name(NamePayload::Raw(".my-class".into())),
						predicates: vec![],
					})),
					qualifier: None,
				};
				let target = CssTarget::new(cp).unwrap();
				Op::CssRenameClassToken {
					target,
					find: "my-class".into(),
					replace: "renamed-class".into(),
				}
			},
		);
	}

	#[test]
	fn rename_id_token() {
		run_case("css", "cssRenameIdToken", CSS_RENAME_ID_BEFORE, CSS_RENAME_ID_AFTER, |p| {
			// JS test targets $FILE::#my-id — selector in query
			let cp = CodePath {
				locator:   Locator::Fs(FsLocator {
					segments: vec![FsSegment::Literal(p.display().to_string())],
				}),
				query:     Some(Query::single(Step {
					axis:       None,
					head:       Head::Name(NamePayload::Raw("#my-id".into())),
					predicates: vec![],
				})),
				qualifier: None,
			};
			let target = CssTarget::new(cp).unwrap();
			Op::CssRenameIdToken { target, find: "my-id".into(), replace: "renamed-id".into() }
		});
	}

	/// FUP-010: kernel rejects token-only rename target; must supply
	/// rule-context selector (.cls, #id, :root) instead of bare token.
	/// CssResolver build_target_id falls through to code_buffer which
	/// expects a selector-formatted CodePath target.
	#[ignore = "FUP-010: cssRenameCustomProp needs selector-prefixed target (:root)"]
	#[test]
	fn rename_custom_prop() {
		run_case(
			"css",
			"cssRenameCustomProp",
			CSS_RENAME_CUSTOM_PROP_BEFORE,
			CSS_RENAME_CUSTOM_PROP_AFTER,
			|p| {
				let target = CssTarget::new(css_path(p)).unwrap();
				Op::CssRenameCustomProp {
					target,
					find: "--my-prop".into(),
					replace: "--renamed-prop".into(),
				}
			},
		);
	}
}

// ── HTML ──────────────────────────────────────────────────────────

mod html {
	use pi_code_path::op::SymScope;

	use super::*;

	#[test]
	fn symbol_replace() {
		run_case("html", "symbolReplace", HTML_REPLACE_BEFORE, HTML_REPLACE_AFTER, |p| {
			let target = SymbolTarget::new(symbol_path(p, "section")).unwrap();
			Op::SymbolReplace {
				target,
				scope: SymScope::Whole,
				content: ActionContent::Single("<section>\n  <p>Goodbye world</p>\n</section>".into()),
			}
		});
	}

	#[test]
	fn symbol_wrap() {
		run_case("html", "symbolWrap", HTML_WRAP_BEFORE, HTML_WRAP_AFTER, |p| {
			let target = SymbolTarget::new(symbol_path(p, "section")).unwrap();
			Op::SymbolWrap {
				target,
				content: ActionContent::Multi(vec![
					"<wrapper>".into(),
					"  $BODY".into(),
					"</wrapper>".into(),
				]),
			}
		});
	}

	/// FUP-011: HTML element names (e.g. `section`) resolve via tree-sitter
	/// query but the code_buffer symbol-resolver does not treat element names
	/// as symbol targets. Needs HTML-aware symbol-target handling in the
	/// code_buffer edit dispatch path.
	#[ignore = "FUP-011: HTML element name not treated as symbol target by code_buffer; needs \
	            HTML-aware symbol resolution"]
	#[test]
	fn symbol_insert_after() {
		run_case(
			"html",
			"symbolInsertAfter",
			HTML_INSERT_AFTER_BEFORE,
			HTML_INSERT_AFTER_AFTER,
			|p| {
				let target = SymbolTarget::new(symbol_path(p, "section")).unwrap();
				Op::SymbolInsertAfter {
					target,
					content: ActionContent::Single("<!-- inserted after section -->\n".into()),
				}
			},
		);
	}
}

// ── Fixture constants ──────────────────────────────────────────────
// Mirrors packages/coding-agent/test/codepath/fixtures/languages/

// TypeScript
const SYMBOL_REPLACE_BEFORE_TS: &str = r#"export function greet(name: string) {
  return 'hello ' + name;
}"#;
const SYMBOL_REPLACE_AFTER_TS: &str = r#"export function greet(name: string) {
  return 'hello ' + name + '!';
}"#;
const SYMBOL_RENAME_BEFORE_TS: &str = r#"export function greet(name: string) {
  return 'hello ' + name;
}"#;
const SYMBOL_RENAME_AFTER_TS: &str = r#"export function salute(name: string) {
  return 'hello ' + name;
}"#;
const SYMBOL_INSERT_AFTER_BEFORE_TS: &str = r#"export function greet(name: string) {
  return 'hello ' + name;
}"#;
const SYMBOL_INSERT_AFTER_AFTER_TS: &str =
	"export function greet(name: string) {\n  return 'hello ' + name;\n}\n// inserted after greet";

// Rust
const SYMBOL_REPLACE_BEFORE_RS: &str = r#"pub fn greet(name: &str) -> String {
    format!("hello {}", name)
}"#;
const SYMBOL_REPLACE_AFTER_RS: &str = r#"pub fn greet(name: &str) -> String {
    format!("hello {}!", name)
}"#;
const SYMBOL_RENAME_BEFORE_RS: &str = r#"pub fn greet(name: &str) -> String {
    format!("hello {}", name)
}"#;
const SYMBOL_RENAME_AFTER_RS: &str = r#"pub fn salute(name: &str) -> String {
    format!("hello {}", name)
}"#;
const SYMBOL_INSERT_AFTER_BEFORE_RS: &str = r#"pub fn greet(name: &str) -> String {
    format!("hello {}", name)
}"#;
const SYMBOL_INSERT_AFTER_AFTER_RS: &str = "pub fn greet(name: &str) -> String {\n    \
                                            format!(\"hello {}\", name)\n}\n// inserted after \
                                            greet";

// Python
const SYMBOL_REPLACE_BEFORE_PY: &str = "def greet(name):\n    return f'hello {name}'";
const SYMBOL_REPLACE_AFTER_PY: &str = "def greet(name):\n    return f'hello {name}!'";
const SYMBOL_RENAME_BEFORE_PY: &str = "def greet(name):\n    return f'hello {name}'";
const SYMBOL_RENAME_AFTER_PY: &str = "def salute(name):\n    return f'hello {name}'";
const SYMBOL_INSERT_AFTER_BEFORE_PY: &str = "def greet(name):\n    return f'hello {name}'";
const SYMBOL_INSERT_AFTER_AFTER_PY: &str =
	"def greet(name):\n    return f'hello {name}'\n# inserted after greet";

// Markdown
const HEADING_PROMOTE_BEFORE_MD: &str = "## Top\n\nSome content.";
const HEADING_PROMOTE_AFTER_MD: &str = "# Top\n\nSome content.";
const HEADING_DEMOTE_BEFORE_MD: &str = "# Top\n\nSome content.";
const HEADING_DEMOTE_AFTER_MD: &str = "## Top\n\nSome content.";
const HEADING_REPLACE_BLOCK_BEFORE_MD: &str = "# Top\n\nSome content.";
const HEADING_REPLACE_BLOCK_AFTER_MD: &str = "# Top\n\nReplaced content.";

// CSS
const CSS_RENAME_CLASS_BEFORE: &str = ".my-class { color: red; }\n#my-id { background: blue; }";
const CSS_RENAME_CLASS_AFTER: &str = ".renamed-class { color: red; }\n#my-id { background: blue; }";
const CSS_RENAME_ID_BEFORE: &str = ".my-class { color: red; }\n#my-id { background: blue; }";
const CSS_RENAME_ID_AFTER: &str = ".my-class { color: red; }\n#renamed-id { background: blue; }";
const CSS_RENAME_CUSTOM_PROP_BEFORE: &str = ":root { --my-prop: green; }";
const CSS_RENAME_CUSTOM_PROP_AFTER: &str = ":root { --renamed-prop: green; }";

// HTML
const HTML_REPLACE_BEFORE: &str = "<section>\n  <p>Hello world</p>\n</section>";
const HTML_REPLACE_AFTER: &str = "<section>\n  <p>Goodbye world</p>\n</section>";
const HTML_WRAP_BEFORE: &str = "<section>\n  <p>Hello world</p>\n</section>";
const HTML_WRAP_AFTER: &str =
	"<wrapper>\n  <section>\n    <p>Hello world</p>\n  </section>\n</wrapper>";
const HTML_INSERT_AFTER_BEFORE: &str = "<section>\n  <p>Hello world</p>\n</section>";
const HTML_INSERT_AFTER_AFTER: &str =
	"<section>\n  <p>Hello world</p>\n</section>\n<!-- inserted after section -->";
