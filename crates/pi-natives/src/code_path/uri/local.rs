//! `local://<filename>` → `<session_dir>/local/<filename>`
//!
//! Session-scoped local cache. Requires a session_dir in SessionContext.

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "local",
		usage:        "local://<filename>",
		root:         RootTemplate::SessionRoot { rel: PathBuf::from("local") },
		layout:       PathLayout::Direct,
		loader:       ContentLoader::FsRead { mode: ReadMode::Auto },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           None,
			cache:               CacheStrategy::None,
			bash_expandable:     true,
			callback_budget:     None,
			static_notes:        &[
				"Use write path local://<file> to persist large intermediate artifacts across turns.",
			],
		},
	}
}
