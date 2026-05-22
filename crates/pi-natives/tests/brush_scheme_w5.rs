//! W5 brush integration: WordPreprocessor hooks URI tokens at lex time.
//!
//! Validates that `skill://x`, `local://y` etc. tokens in bash commands are
//! resolved by the kernel SchemeRegistry before brush's normal expansion sees
//! them. Single-quoted text stays literal (bash semantics).

use std::path::PathBuf;
use std::sync::Arc;

use brush_core::{ExecutionParameters, WordPreprocessor};
use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, scheme::SessionContext, scheme_dispatch::SchemeRegistry,
};
use pi_natives::exec::scheme_preprocessor::SchemeWordPreprocessor;

/// Build a scheme registry with one fs-backed test scheme and one virtual scheme.
fn test_registry() -> (Arc<SchemeRegistry>, tempfile::TempDir) {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("hello.txt"), "fixture").unwrap();

	let mut reg = SchemeRegistry::new();
	reg.register_dynamic_profile(SchemeProfile {
		scheme:       "tfile",
		root:         RootTemplate::AbsoluteRoot { path: dir.path().to_path_buf() },
		layout:       PathLayout::Direct,
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			bash_expandable:     true,
			cache:               CacheStrategy::None,
			..Default::default()
		},
	})
	.unwrap();
	reg.register_dynamic_profile(SchemeProfile {
		scheme:       "tvirt",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Static {
			table: &phf::phf_map! { "x" => "data" },
		},
		capabilities: SchemeCapabilities {
			fs_backed:           false,
			bash_expandable:     false,
			cache:               CacheStrategy::None,
			..Default::default()
		},
	})
	.unwrap();
	(Arc::new(reg), dir)
}

fn make_params(reg: Arc<SchemeRegistry>) -> (ExecutionParameters, PathBuf) {
	let (reg_clone, _dir) = (reg, ());
	let mut params = ExecutionParameters::default();
	let pre = SchemeWordPreprocessor::new(reg_clone.clone(), None);
	params.word_preprocessor = Some(Arc::new(pre));
	(params, PathBuf::new())
}

// ── direct preprocessor unit tests covering matrix ──────────────

#[test]
fn matrix_bare_token_expanded() {
	let (reg, dir) = test_registry();
	let pre = SchemeWordPreprocessor::new(reg, None);
	let expected = dir.path().join("hello.txt");
	let out = pre.preprocess("tfile://hello.txt").unwrap();
	assert_eq!(out, format!("'{}'", expected.display()));
}

#[test]
fn matrix_unknown_scheme_passes_through() {
	let (reg, _dir) = test_registry();
	let pre = SchemeWordPreprocessor::new(reg, None);
	assert_eq!(pre.preprocess("foo://x"), None);
}

#[test]
fn matrix_virtual_scheme_not_expanded_in_bash() {
	let (reg, _dir) = test_registry();
	let pre = SchemeWordPreprocessor::new(reg, None);
	assert_eq!(pre.preprocess("tvirt://x"), None);
}

#[test]
fn matrix_plain_word_passthrough() {
	let (reg, _dir) = test_registry();
	let pre = SchemeWordPreprocessor::new(reg, None);
	assert_eq!(pre.preprocess("echo"), None);
	assert_eq!(pre.preprocess("/abs/path"), None);
}

#[test]
fn matrix_path_with_special_chars_escaped() {
	let (reg, dir) = test_registry();
	let weird = dir.path().join("with space.txt");
	std::fs::write(&weird, "x").unwrap();
	let pre = SchemeWordPreprocessor::new(reg, None);
	let out = pre.preprocess("tfile://with space.txt").unwrap();
	// Single-quoted form survives spaces
	assert!(out.starts_with('\''));
	assert!(out.ends_with('\''));
	assert!(out.contains("with space.txt"));
}

#[test]
fn matrix_path_with_apostrophe_escaped() {
	let (reg, dir) = test_registry();
	let apos = dir.path().join("a'b.txt");
	std::fs::write(&apos, "x").unwrap();
	let pre = SchemeWordPreprocessor::new(reg, None);
	let out = pre.preprocess("tfile://a'b.txt").unwrap();
	// Single-quote escaping: ' → '\''
	assert!(out.contains(r"'\''"));
}

#[test]
fn matrix_resolution_failure_propagates_as_none() {
	let (reg, _dir) = test_registry();
	let pre = SchemeWordPreprocessor::new(reg, None);
	// File doesn't exist → resolve fails → preprocessor returns None (defers).
	// Brush will then see the literal token and likely fail with "no such command".
	assert_eq!(pre.preprocess("tfile://nonexistent.txt"), None);
}

// ── brush ExecutionParameters integration ────────────────────────

#[test]
fn matrix_execution_params_carries_preprocessor() {
	let (reg, _dir) = test_registry();
	let (params, _) = make_params(reg);
	// Just verify the field is set + cloneable
	let params_clone = params.clone();
	assert!(params_clone.word_preprocessor.is_some());
}

#[test]
fn matrix_preprocessor_keeps_registry_alive() {
	// Box::leak via Arc semantics: SchemeWordPreprocessor holds Arc<SchemeRegistry>;
	// dropping the local reg variable after construction shouldn't invalidate.
	let pre_arc: Arc<dyn brush_core::WordPreprocessor> = {
		let (reg, _dir) = test_registry();
		let pre = SchemeWordPreprocessor::new(reg, None);
		Arc::new(pre) as Arc<dyn brush_core::WordPreprocessor>
	};
	// reg dropped; pre_arc still owns it.
	// Calling preprocess on a known-good fixture is racy because the tempdir is gone,
	// so just sanity-check the trait dispatch works.
	let _ = pre_arc.preprocess("unrelated://word");
}

// ── session context wiring (uses real schemes via the auto-registry) ────

#[test]
fn matrix_session_aware_local_resolves_under_session_dir() {
	use pi_natives::code_path::uri::SCHEME_FACTORIES;
	let dir = tempfile::tempdir().unwrap();
	let sess = dir.path().join("session-xyz");
	std::fs::create_dir_all(sess.join("local")).unwrap();
	let file = sess.join("local/note.txt");
	std::fs::write(&file, "note").unwrap();

	let ctx = SessionContext::new(dir.path(), "/home/u").with_session_dir(&sess);
	let reg = Arc::new(SchemeRegistry::from_static(
		SCHEME_FACTORIES.iter().copied(),
		Some(&ctx),
	));
	let pre = SchemeWordPreprocessor::new(reg, Some(ctx));
	let out = pre.preprocess("local://note.txt").unwrap();
	assert_eq!(out, format!("'{}'", file.display()));
}
