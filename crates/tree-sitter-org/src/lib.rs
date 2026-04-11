//! Org-mode grammar for the [tree-sitter][] parsing library.
//!
//! Vendored from [milisims/tree-sitter-org](https://github.com/milisims/tree-sitter-org) (MIT),
//! adapted for tree-sitter 0.25+ (`LanguageFn` API).
//!
//! ```
//! use tree_sitter::Parser;
//!
//! let mut parser = Parser::new();
//! parser
//!     .set_language(&tree_sitter_org::LANGUAGE.into())
//!     .expect("Error loading org grammar");
//! let tree = parser.parse("* TODO Hello\n", None).unwrap();
//! assert!(!tree.root_node().has_error());
//! ```
//!
//! [tree-sitter]: https://tree-sitter.github.io/

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
	fn tree_sitter_org() -> *const ();
}

/// The tree-sitter [`LanguageFn`] for org-mode.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_org) };

/// The content of the [`node-types.json`][] file for this grammar.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers#static-node-types
pub const NODE_TYPES: &str = include_str!("node-types.json");

#[cfg(test)]
mod tests {
	#[test]
	fn test_can_load_grammar() {
		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&super::LANGUAGE.into())
			.expect("Error loading org grammar");
	}

	#[test]
	fn test_parse_basic_heading() {
		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&super::LANGUAGE.into())
			.expect("Error loading org grammar");
		let tree = parser.parse("* TODO Hello world\n", None).unwrap();
		let root = tree.root_node();
		assert!(!root.has_error());
		assert_eq!(root.kind(), "document");
	}

	#[test]
	fn test_parse_properties_drawer() {
		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&super::LANGUAGE.into())
			.expect("Error loading org grammar");
		let src =
			"* DOING My task\n:PROPERTIES:\n:CUSTOM_ID: PROJ-001-my-task\n:END:\nBody text here.\n";
		let tree = parser.parse(src, None).unwrap();
		assert!(!tree.root_node().has_error());
	}
}
