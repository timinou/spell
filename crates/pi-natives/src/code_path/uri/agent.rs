//! `agent://<id>` → `<session_dir>/<id>.md`
//!
//! Resolves agent output IDs to artifact files in the current session
//! directory. JSON path projection (`agent://<id>/<jsonpath>` and `?q=`) is
//! deferred to the kernel `#json:<expr>` qualifier (PLAN-310 W7).

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "agent",
		root:         RootTemplate::SessionRoot { rel: PathBuf::from("") },
		layout:       PathLayout::NamedFile { extension: "md".into() },
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     true,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
