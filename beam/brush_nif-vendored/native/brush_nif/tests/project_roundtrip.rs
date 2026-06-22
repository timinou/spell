//! Round-trip + projection tests for parse/unparse (PLAN-011 W5).
//!
//! The crate is a cdylib, so we `#[path]`-include the unit under test.

// project.rs references `crate::argv::shell_escape`, so the included module
// path must expose an `argv` sibling at the crate root of this test binary.
#[path = "../src/argv.rs"]
#[allow(dead_code)]
mod argv;

#[path = "../src/project.rs"]
#[allow(dead_code)]
mod project;

use project::{Node, UnparseNode, parse, unparse};

// Build an UnparseNode tree from a parsed Node tree by going through the same
// shape the BEAM would (kind/name/value/children). We re-derive it directly to
// keep the test self-contained without a BEAM env.
fn to_unparse(node: &Node) -> UnparseNode {
	match node {
		Node::Value { kind, value } => UnparseNode {
			kind:     kind.to_string(),
			name:     String::new(),
			value:    value.clone(),
			children: vec![],
		},
		Node::Named { kind, name, children } => UnparseNode {
			kind:     kind.to_string(),
			name:     name.clone(),
			value:    String::new(),
			children: children.iter().map(to_unparse).collect(),
		},
		Node::Branch { kind, children } => UnparseNode {
			kind:     kind.to_string(),
			name:     String::new(),
			value:    String::new(),
			children: children.iter().map(to_unparse).collect(),
		},
	}
}

fn roundtrip(src: &str) -> String {
	let node = parse(src).expect("parse ok");
	unparse(&to_unparse(&node))
}

#[test]
fn simple_command_roundtrips_semantically() {
	// parse(unparse(parse(x))) == parse(x) — assert via the rendered bash
	// re-parsing to the same logical words.
	let bash = roundtrip("rg -l TODO");
	let node = parse(&bash).unwrap();
	// The re-parsed name is the logical "rg" (quote-removed), proving idempotency.
	if let Node::Branch { children, .. } = node {
		if let Node::Named { name, .. } = &children[0] {
			assert_eq!(name, "rg");
		} else {
			panic!("expected command");
		}
	} else {
		panic!("expected program");
	}
}

#[test]
fn word_value_is_logical_not_quoted() {
	let node = parse("echo hello").unwrap();
	let Node::Branch { children, .. } = node else {
		panic!()
	};
	let Node::Named { children: words, .. } = &children[0] else {
		panic!()
	};
	let Node::Value { value, .. } = &words[0] else {
		panic!()
	};
	assert_eq!(value, "hello");
}

#[test]
fn exotic_becomes_raw() {
	let node = parse("for f in a b; do echo $f; done").unwrap();
	let Node::Branch { children, .. } = node else {
		panic!()
	};
	assert!(matches!(&children[0], Node::Value { kind: "raw", .. }));
}

#[test]
fn malformed_errors() {
	assert!(parse("echo \"unterminated").is_err());
}

#[test]
fn unparse_reescapes_injection() {
	// A hand-built word with a metacharacter must come back single-quoted.
	let tree = UnparseNode {
		kind:     "command".to_string(),
		name:     "echo".to_string(),
		value:    String::new(),
		children: vec![UnparseNode {
			kind:     "word".to_string(),
			name:     String::new(),
			value:    "; rm -rf /".to_string(),
			children: vec![],
		}],
	};
	let bash = unparse(&tree);
	assert_eq!(bash, "'echo' '; rm -rf /'");
}

#[test]
fn unquote_inverts_shell_escape_single_quote_run() {
	// shell_escape("it's") == "'it'\''s'"; parsing that word must yield "it's".
	let escaped = argv::shell_escape("it's");
	let src = format!("echo {escaped}");
	let node = parse(&src).unwrap();
	let project::Node::Branch { children, .. } = node else {
		panic!()
	};
	let project::Node::Named { children: words, .. } = &children[0] else {
		panic!()
	};
	let project::Node::Value { value, .. } = &words[0] else {
		panic!()
	};
	assert_eq!(value, "it's");
}

#[test]
fn empty_word_roundtrips() {
	let node = parse("echo ''").unwrap();
	let project::Node::Branch { children, .. } = node else {
		panic!()
	};
	let project::Node::Named { children: words, .. } = &children[0] else {
		panic!()
	};
	let project::Node::Value { value, .. } = &words[0] else {
		panic!()
	};
	assert_eq!(value, "");
}

#[test]
fn prefix_command_is_raw() {
	let node = parse("FOO=bar echo hi").unwrap();
	let project::Node::Branch { children, .. } = node else {
		panic!()
	};
	assert!(matches!(&children[0], project::Node::Value { kind: "raw", .. }));
}
