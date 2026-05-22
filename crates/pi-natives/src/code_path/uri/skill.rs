//! `skill://<name>` → `<project_root>/.spell/skills/<name>/SKILL.md`
//! `skill://<name>/<path>` → `<project_root>/.spell/skills/<name>/<path>`
//!
//! Per PLAN-310: kernel owns this scheme. Replaces TS skill-protocol.ts.

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "skill",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/skills") },
		layout:       PathLayout::NamedDir {
			entry_file:      "SKILL.md".into(),
			subpath_allowed: true,
		},
		loader:       ContentLoader::FsRead { mode: ReadMode::Auto },
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
