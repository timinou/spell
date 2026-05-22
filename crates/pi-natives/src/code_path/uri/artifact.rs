//! `artifact://<session-id>/<agent>/<tool>/<n>.<ext>` → full session-scoped path.
//! `artifact://<id>`                                  → legacy current-session form.
//!
//! Both forms use `RootTemplate::ProjectRoot { rel: ".spell/sessions" }` and
//! consume the body verbatim. The full form addresses any session by id;
//! the legacy form addresses the current session's `<session_dir>/<id>`.
//!
//! Auto read mode handles binary artifacts (.png/.pdf/etc) by returning a
//! pending Bytes marker; downstream tools materialize via the artifact store.
//!
//! PLAN-310 W3. Cross-session-id index lookup is deferred to FUP-1
//! (artifact-uri-cross-session) — current Direct form requires the body to
//! be a valid relative path under the sessions root.

use std::path::PathBuf;

use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, ReadMode, RootTemplate, SchemeCapabilities,
	SchemeProfile, SessionContext,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "artifact",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/sessions") },
		layout:       PathLayout::Direct,
		loader:       ContentLoader::FsRead { mode: ReadMode::Auto },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           None,
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     true,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
