//! `rule://<name>` → `<project_root>/.spell/rules/<name>.md`

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "rule",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/rules") },
		layout:       PathLayout::NamedFile { extension: "md".into() },
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     true,
			callback_budget:     None,
		},
	}
}
