//! `org://<CUSTOM_ID>` → org task body at the heading region.
//!
//! Resolves item IDs to (path, byte_range) via `pi-org-engine`'s
//! `MultiRootIndex`. Lazy build per session; invalidates on directory mtime
//! change. Scans every subdirectory of `~/.org/` as a category root.
//!
//! PLAN-310 W3 D6. CUSTOM_IDs are globally unique across categories per
//! the org spec, so no category prefix is required in the URI.

use std::{
	path::{Path, PathBuf},
	sync::{Arc, RwLock},
	time::SystemTime,
};

use pi_code_path::{
	CacheStrategy, ContentLoader, IndexLookup, PathLayout, ResolvedAddress, RootTemplate,
	SchemeCapabilities, SchemeProfile, SessionContext,
	resolver::traits::CancellationToken,
	types::{Diagnostic, DiagnosticVariant},
};
use pi_org_engine::{
	extract_items_from_source,
	locate::{MultiRootIndex, RootScope},
};

/// Default TODO keywords for parsing. Matches the kernel-wide list used by
/// pi-org-engine callers; deliberately small to keep the index lean.
const TODO_KEYWORDS: &[&str] = &["TODO", "DOING", "DONE", "REVIEW", "BLOCKED", "ITEM"];

#[derive(Default)]
struct OrgIdLookup {
	/// Cached (mtime, index). Mtime is the latest dir mtime seen at build time.
	cache: RwLock<Option<(SystemTime, MultiRootIndex)>>,
}

impl OrgIdLookup {
	/// Collect candidate org roots for the current session.
	///
	/// Two sources, both scanned (categories merged):
	///   1. Project default: `<project_root>/!tasks/` — DEFAULT_ORG_CONFIG.dirs.tasks
	///      with subdirs plans/, features/, bugs/, follow-ups/, drafts/, audits/,
	///      projects/.
	///   2. Personal: `<home>/.org/` — legacy/personal store.
	///
	/// CUSTOM_IDs are globally unique across categories so the same item is never
	/// in two roots; merge order doesn't matter semantically.
	fn category_dirs(ctx: Option<&SessionContext>) -> Result<Vec<PathBuf>, Diagnostic> {
		let ctx = ctx.ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "org:// requires SessionContext".into(),
			span:    None,
		})?;
		let mut roots = Vec::new();
		roots.push(ctx.project_root.join("!tasks"));
		roots.push(ctx.home.join(".org"));
		Ok(roots)
	}

	fn collect_categories(dirs: &[PathBuf]) -> Vec<(RootScope, PathBuf)> {
		let mut roots: Vec<(RootScope, PathBuf)> = Vec::new();
		for root in dirs {
			let Ok(rd) = std::fs::read_dir(root) else { continue };
			for entry in rd.flatten() {
				if entry.path().is_dir() {
					roots.push((RootScope::Personal, entry.path()));
				}
			}
		}
		roots.sort_by(|a, b| a.1.cmp(&b.1));
		roots
	}

	fn latest_mtime(roots: &[(RootScope, PathBuf)]) -> SystemTime {
		roots
			.iter()
			.filter_map(|(_, p)| std::fs::metadata(p).ok())
			.filter_map(|m| m.modified().ok())
			.max()
			.unwrap_or(SystemTime::UNIX_EPOCH)
	}

	fn get_or_build(&self, ctx: Option<&SessionContext>) -> Result<MultiRootIndex, Diagnostic> {
		let dirs = Self::category_dirs(ctx)?;
		let category_roots = Self::collect_categories(&dirs);
		let current_mtime = Self::latest_mtime(&category_roots);

		// Fast-path
		{
			let cached = self.cache.read().expect("org index lock poisoned");
			if let Some((mtime, idx)) = cached.as_ref() {
				if *mtime == current_mtime {
					return Ok(idx.clone());
				}
			}
		}

		// Build
		let refs: Vec<(RootScope, &Path)> = category_roots
			.iter()
			.map(|(s, p)| (*s, p.as_path()))
			.collect();
		let index = MultiRootIndex::build(&refs, TODO_KEYWORDS);
		*self.cache.write().expect("org index lock poisoned") =
			Some((current_mtime, index.clone()));
		Ok(index)
	}
}

impl IndexLookup for OrgIdLookup {
	fn lookup(
		&self,
		body: &str,
		ctx: Option<&SessionContext>,
		_cancel: &CancellationToken,
	) -> Result<ResolvedAddress, Diagnostic> {
		let index = self.get_or_build(ctx)?;
		let (_scope, path) = index.resolve(body).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::FileNotFound,
			message: format!("no item with CUSTOM_ID '{body}'"),
			span:    None,
		})?;
		let path = path.to_path_buf();

		// Extract byte range + title for the heading region.
		let source = std::fs::read_to_string(&path).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("read {}: {e}", path.display()),
			span:    None,
		})?;
		let items = extract_items_from_source(&source, TODO_KEYWORDS, "", "", "", true)
			.unwrap_or_default();
		let (range, title) = find_item_range_and_title(&items, body);
		let mut notes = Vec::new();
		if let Some(t) = title {
			notes.push(format!("Org item: {t} ({body})"));
		}
		Ok(ResolvedAddress { path, range, notes })
	}
}

fn find_item_range_and_title(
	items: &[pi_org_engine::OrgItem],
	id: &str,
) -> (Option<std::ops::Range<usize>>, Option<String>) {
	for item in items {
		if item.id == id {
			return (
				Some(item.byte_range.0..item.byte_range.1),
				Some(item.title.clone()),
			);
		}
		let (r, t) = find_item_range_and_title(&item.children, id);
		if r.is_some() {
			return (r, t);
		}
	}
	(None, None)
}

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "org",
		usage:        "org://<CUSTOM_ID>",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Indexed,
		loader:       ContentLoader::Indexed {
			lookup:    Arc::new(OrgIdLookup::default()),
			read_mode: pi_code_path::ReadMode::Utf8Text,
		},
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/x-org"),
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     false,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}


