//! `memory://root[/<path>]` → `<project_root>/.spell/memory/[<path>|memory_summary.md]`
//!
//! TS parity: matches `MemoryProtocolHandler` in
//! `packages/coding-agent/src/internal-urls/memory-protocol.ts`.
//!
//! - `memory://root`         → `<root>/memory_summary.md`
//! - `memory://root/foo.md`  → `<root>/foo.md`
//! - Any other namespace rejected with diagnostic.

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "memory",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/memory") },
		layout:       PathLayout::Namespaced {
			namespace:        "root".to_string(),
			default_file:     "memory_summary.md".to_string(),
			subpath_allowed:  true,
		},
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::None,
			bash_expandable:     true,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
