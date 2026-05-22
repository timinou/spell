//! `pi://<filename>` → embedded markdown doc bundled at build time.
//!
//! The build.rs script walks `<workspace>/docs/**/*.md` and emits the
//! `EMBEDDED_DOCS` phf::Map below. Adding a doc = no code change; the build
//! script picks it up automatically.
//!
//! This replaces the TS `EMBEDDED_DOCS` table in
//! `packages/coding-agent/src/internal-urls/docs-index.generated.ts`.

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, RootTemplate, SchemeCapabilities, SchemeProfile,
	SessionContext,
};

// `pi_docs_index.rs` contains `pub static EMBEDDED_DOCS: phf::Map<...>` +
// `pub static EMBEDDED_DOC_FILENAMES: &[&str]`.
include!(concat!(env!("OUT_DIR"), "/pi_docs_index.rs"));

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "pi",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Static { table: &EMBEDDED_DOCS },
		capabilities: SchemeCapabilities {
			fs_backed:           false,
			codepath_compatible: false,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::None, // already compiled in
			bash_expandable:     false,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
