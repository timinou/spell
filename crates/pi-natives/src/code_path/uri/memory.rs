//! `memory://<path>` → `<project_root>/.spell/memory/<path>`
//!
//! `memory://root` resolves to `memory_summary.md` per TS-side convention.

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "memory",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/memory") },
		layout:       PathLayout::Direct,
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::None,
			bash_expandable:     true,
			callback_budget:     None,
		},
	}
}
