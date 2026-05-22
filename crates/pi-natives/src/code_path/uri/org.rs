//! `org://<CUSTOM_ID>` → org task body at the heading region.
//!
//! Resolves item IDs to (path, byte_range) via `pi-org-engine`'s
//! `MultiRootIndex`. Lazy build per session; invalidates on directory mtime
//! change. Scans every subdirectory of `~/.org/` as a category root.
//!
//! PLAN-310 W3 D6. CUSTOM_IDs are globally unique across categories per
//! the org spec, so no category prefix is required in the URI.

use std::{
	collections::HashMap,
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
	fn org_root(ctx: Option<&SessionContext>) -> Result<PathBuf, Diagnostic> {
		ctx.map(|c| c.home.join(".org"))
			.ok_or_else(|| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: "org:// requires SessionContext with home dir".into(),
				span:    None,
			})
	}

	fn collect_categories(root: &Path) -> Vec<(RootScope, PathBuf)> {
		let mut roots: Vec<(RootScope, PathBuf)> = Vec::new();
		let Ok(rd) = std::fs::read_dir(root) else {
			return roots;
		};
		for entry in rd.flatten() {
			if entry.path().is_dir() {
				roots.push((RootScope::Personal, entry.path()));
			}
		}
		// Stable ordering for deterministic resolution.
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
		let org_root = Self::org_root(ctx)?;
		let category_roots = Self::collect_categories(&org_root);
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
			message: format!("org item not found: org://{body}"),
			span:    None,
		})?;
		let path = path.to_path_buf();

		// Extract byte range of the heading region.
		let source = std::fs::read_to_string(&path).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("read {}: {e}", path.display()),
			span:    None,
		})?;
		let items = extract_items_from_source(&source, TODO_KEYWORDS, "", "", "", true)
			.unwrap_or_default();
		let range = find_item_range(&items, body);
		Ok(ResolvedAddress { path, range })
	}
}

fn find_item_range(items: &[pi_org_engine::OrgItem], id: &str) -> Option<std::ops::Range<usize>> {
	for item in items {
		if item.id == id {
			return Some(item.byte_range.0..item.byte_range.1);
		}
		if let Some(r) = find_item_range(&item.children, id) {
			return Some(r);
		}
	}
	None
}

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "org",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Indexed,
		loader:       ContentLoader::Indexed { lookup: Arc::new(OrgIdLookup::default()) },
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           Some("text/x-org"),
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     false,
			callback_budget:     None,
		},
	}
}

#[allow(dead_code)]
fn _unused_hashmap_placeholder(h: HashMap<String, String>) {
	let _ = h;
}
