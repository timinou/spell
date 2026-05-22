//! `jobs://<id>`            → synthesized status+result+error+progress summary
//! `jobs://<id>#status`     → `<root>/<id>/status.txt`
//! `jobs://<id>#result`     → `<root>/<id>/result.txt`
//! `jobs://<id>#error`      → `<root>/<id>/error.txt`
//! `jobs://<id>#stderr`     → `<root>/<id>/stderr.txt`
//! `jobs://<id>#progress`   → `<root>/<id>/progress.txt`
//!
//! Disk-backed per the (deleted-then-restored) FEAT-722 design. AsyncJobManager
//! must persist job state to `.spell/jobs/<id>/` for these URIs to resolve.
//! See PLAN-310; mismatch with in-memory-only AsyncJobManager is BUG-393 if
//! we discover one during W4 cutover.

use std::{collections::HashMap, path::PathBuf};

use pi_code_path::{
	CacheStrategy, ContentLoader, FragmentEntry, PathLayout, ReadMode, RootTemplate,
	SchemeCapabilities, SchemeProfile, SessionContext, SynthReducer, SynthSpec,
};

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	let mut fragments = HashMap::new();
	fragments.insert("status".into(), FragmentEntry::File("status.txt".into()));
	fragments.insert("result".into(), FragmentEntry::File("result.txt".into()));
	fragments.insert("error".into(), FragmentEntry::File("error.txt".into()));
	fragments.insert("stderr".into(), FragmentEntry::File("stderr.txt".into()));
	fragments.insert("progress".into(), FragmentEntry::File("progress.txt".into()));

	SchemeProfile {
		scheme:       "jobs",
		root:         RootTemplate::ProjectRoot { rel: PathBuf::from(".spell/jobs") },
		layout:       PathLayout::IdFragment {
			default:   FragmentEntry::Synth(SynthSpec {
				parts:   vec![
					("status".into(), "status.txt".into()),
					("result".into(), "result.txt".into()),
					("error".into(), "error.txt".into()),
					("progress".into(), "progress.txt".into()),
				],
				reducer: SynthReducer::LabeledConcat,
			}),
			fragments,
		},
		loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: false, // synthesized summary; codepath doesn't compose
			mime_hint:           Some("text/markdown"),
			cache:               CacheStrategy::None, // job state is live
			bash_expandable:     false,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
