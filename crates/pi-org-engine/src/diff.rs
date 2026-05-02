//! Org-item diff payload broadcast over the broker after a commit.
//!
//! Subscribers (recall cache, QML/TUI panels) consume `OrgItemPatch`
//! lists to invalidate caches and re-render only items whose touched
//! fields intersect their filter. The diff is computed by
//! [`compute_patches`] from before/after `OrgItem` snapshots; the broker
//! attaches the patch list to `PeerCommitted` / `MultiPeerCommitted`
//! (FEAT-639::protocol-extend).

use std::{
	collections::{BTreeMap, BTreeSet, HashSet},
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{edge::EdgeKind, item::OrgItem};

/// Whether the item appeared, mutated, or vanished between snapshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchKind {
	Added,
	Modified,
	Deleted,
}

/// Patch describing how a single org item changed between two snapshots
/// of a file. Designed to be cheap to ship over the broker socket and
/// cheap to filter against an `OrgQlFilter`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgItemPatch {
	pub id:                 String,
	pub file:               PathBuf,
	pub kind:               PatchKind,
	#[serde(default)]
	pub touched_props:      Vec<String>,
	#[serde(default)]
	pub touched_relations:  Vec<EdgeKind>,
	#[serde(default)]
	pub touched_body:       bool,
	#[serde(default)]
	pub touched_state:      bool,
	#[serde(default)]
	pub touched_tags:       bool,
}

/// Compute patches between two ordered slices of items belonging to the
/// same file. Items without a `CUSTOM_ID` are skipped.
#[must_use]
pub fn compute_patches(before: &[OrgItem], after: &[OrgItem], file: &Path) -> Vec<OrgItemPatch> {
	let before_map = index_by_id(before);
	let after_map = index_by_id(after);

	let mut patches = Vec::new();
	let mut seen: HashSet<&str> = HashSet::new();

	for (id, after_item) in &after_map {
		seen.insert(id.as_str());
		if let Some(before_item) = before_map.get(id) {
			if let Some(patch) = diff_one(before_item, after_item, file) {
				patches.push(patch);
			}
		} else {
			patches.push(OrgItemPatch {
				id:                id.clone(),
				file:              file.to_path_buf(),
				kind:              PatchKind::Added,
				touched_props:     after_item
					.properties
					.keys()
					.cloned()
					.collect::<Vec<_>>(),
				touched_relations: vec![],
				touched_body:      after_item.body.as_ref().is_some_and(|b| !b.is_empty()),
				touched_state:     !after_item.state.is_empty(),
				touched_tags:      false,
			});
		}
	}

	for (id, before_item) in &before_map {
		if seen.contains(id.as_str()) {
			continue;
		}
		patches.push(OrgItemPatch {
			id:                id.clone(),
			file:              file.to_path_buf(),
			kind:              PatchKind::Deleted,
			touched_props:     before_item
				.properties
				.keys()
				.cloned()
				.collect::<Vec<_>>(),
			touched_relations: vec![],
			touched_body:      before_item.body.as_ref().is_some_and(|b| !b.is_empty()),
			touched_state:     !before_item.state.is_empty(),
			touched_tags:      false,
		});
	}

	patches
}

fn diff_one(before: &OrgItem, after: &OrgItem, file: &Path) -> Option<OrgItemPatch> {
	let mut touched_props = Vec::new();
	let before_keys: BTreeSet<&String> = before.properties.keys().collect();
	let after_keys: BTreeSet<&String> = after.properties.keys().collect();
	for key in before_keys.union(&after_keys) {
		let b = before.properties.get(*key);
		let a = after.properties.get(*key);
		if b != a {
			touched_props.push((*key).clone());
		}
	}

	let mut touched_relations: BTreeSet<EdgeKind> = BTreeSet::new();
	let before_rel: BTreeSet<(EdgeKind, String)> =
		before.relations.iter().cloned().collect();
	let after_rel: BTreeSet<(EdgeKind, String)> = after.relations.iter().cloned().collect();
	for (kind, _target) in before_rel.symmetric_difference(&after_rel) {
		touched_relations.insert(kind.clone());
	}

	let touched_body = before.body != after.body;
	let touched_state = before.state != after.state;

	if touched_props.is_empty()
		&& touched_relations.is_empty()
		&& !touched_body
		&& !touched_state
	{
		return None;
	}

	Some(OrgItemPatch {
		id:                after.id.clone(),
		file:              file.to_path_buf(),
		kind:              PatchKind::Modified,
		touched_props,
		touched_relations: touched_relations.into_iter().collect(),
		touched_body,
		touched_state,
		touched_tags:      false,
	})
}

fn index_by_id(items: &[OrgItem]) -> BTreeMap<String, &OrgItem> {
	let mut map = BTreeMap::new();
	for item in items {
		if !item.id.is_empty() {
			map.insert(item.id.clone(), item);
		}
		// also index nested children so that headings inside this file are visible
		for child in &item.children {
			collect_nested(child, &mut map);
		}
	}
	map
}

fn collect_nested<'a>(item: &'a OrgItem, map: &mut BTreeMap<String, &'a OrgItem>) {
	if !item.id.is_empty() {
		map.insert(item.id.clone(), item);
	}
	for child in &item.children {
		collect_nested(child, map);
	}
}

fn collect_relation_kinds(rels: &[(EdgeKind, String)]) -> Vec<EdgeKind> {
	let set: BTreeSet<EdgeKind> = rels.iter().map(|(k, _)| k.clone()).collect();
	set.into_iter().collect()
}

// EdgeKind needs Ord for use in BTreeSet
impl PartialOrd for EdgeKind {
	fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for EdgeKind {
	fn cmp(&self, other: &Self) -> std::cmp::Ordering {
		self.token().cmp(&other.token())
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;

	fn item(id: &str) -> OrgItem {
		OrgItem {
			id:         id.into(),
			title:      String::new(),
			state:      String::new(),
			category:   String::new(),
			dir:        String::new(),
			file:       String::new(),
			line:       1,
			level:      1,
			properties: HashMap::new(),
			body:       None,
			clocks:     vec![],
			byte_range: (0, 0),
			children:   vec![],
			relations:  vec![],
		}
	}

	#[test]
	fn detects_added_item() {
		let before = vec![item("a")];
		let mut b = item("b");
		b.title = "new".into();
		let after = vec![item("a"), b];
		let patches = compute_patches(&before, &after, Path::new("/x.org"));
		assert_eq!(patches.len(), 1);
		assert_eq!(patches[0].kind, PatchKind::Added);
		assert_eq!(patches[0].id, "b");
	}

	#[test]
	fn detects_deleted_item() {
		let before = vec![item("a"), item("b")];
		let after = vec![item("a")];
		let patches = compute_patches(&before, &after, Path::new("/x.org"));
		assert_eq!(patches.len(), 1);
		assert_eq!(patches[0].kind, PatchKind::Deleted);
		assert_eq!(patches[0].id, "b");
	}

	#[test]
	fn detects_property_change() {
		let mut a_before = item("a");
		a_before.properties.insert("CONFIDENCE".into(), "0.5".into());
		let mut a_after = item("a");
		a_after.properties.insert("CONFIDENCE".into(), "0.7".into());
		let patches = compute_patches(&[a_before], &[a_after], Path::new("/x.org"));
		assert_eq!(patches.len(), 1);
		assert_eq!(patches[0].touched_props, vec!["CONFIDENCE"]);
	}

	#[test]
	fn detects_relation_change() {
		let a_before = item("a");
		let mut a_after = item("a");
		a_after
			.relations
			.push((EdgeKind::About, "ENT-x".into()));
		let patches = compute_patches(&[a_before], &[a_after], Path::new("/x.org"));
		assert_eq!(patches.len(), 1);
		assert_eq!(patches[0].touched_relations, vec![EdgeKind::About]);
	}
}
