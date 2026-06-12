use std::{
	path::Path,
	sync::{Arc, OnceLock},
};

use pi_code_path::{
	dialect::NameLexer,
	dialects::{
		css::css_dialect, go::go_dialect, haskell::haskell_dialect, html::html_dialect,
		mdorg::markdown_dialect, python::python_dialect, rust::rust_dialect,
		typescript::typescript_dialect,
	},
};

/// Select a [`NameLexer`] based on the file extension of `path`.
///
/// Uses the **last** extension (e.g. `foo.test.ts` → `.ts`).
/// Returns `None` for unknown extensions, non-UTF-8 paths, or paths
/// without an extension.
pub fn select_dialect(path: &Path) -> Option<Arc<dyn NameLexer>> {
	let ext = path.extension().and_then(|e| e.to_str())?;
	match ext {
		"ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(
			TS_LEXER
				.get_or_init(|| typescript_dialect().name_lexer)
				.clone(),
		),
		"rs" => Some(RUST_LEXER.get_or_init(|| rust_dialect().name_lexer).clone()),
		"py" => Some(
			PYTHON_LEXER
				.get_or_init(|| python_dialect().name_lexer)
				.clone(),
		),
		"go" => Some(GO_LEXER.get_or_init(|| go_dialect().name_lexer).clone()),
		"hs" | "lhs" => Some(
			HASKELL_LEXER
				.get_or_init(|| haskell_dialect().name_lexer)
				.clone(),
		),
		"html" | "htm" => Some(HTML_LEXER.get_or_init(|| html_dialect().name_lexer).clone()),
		"css" => Some(CSS_LEXER.get_or_init(|| css_dialect().name_lexer).clone()),
		"md" | "mdx" | "org" => Some(
			MDORG_LEXER
				.get_or_init(|| markdown_dialect().name_lexer)
				.clone(),
		),
		_ => None,
	}
}

static TS_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static RUST_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static PYTHON_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static GO_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static HASKELL_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static HTML_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static CSS_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();
static MDORG_LEXER: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();

/// Return all registered extensions that have a dialect lexer.
pub fn registered_extensions() -> Vec<String> {
	vec![
		"ts".into(),
		"tsx".into(),
		"js".into(),
		"jsx".into(),
		"mjs".into(),
		"cjs".into(),
		"rs".into(),
		"py".into(),
		"go".into(),
		"hs".into(),
		"lhs".into(),
		"html".into(),
		"htm".into(),
		"css".into(),
		"md".into(),
		"mdx".into(),
		"org".into(),
	]
}
