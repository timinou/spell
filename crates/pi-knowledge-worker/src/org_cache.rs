//! BUG-474 — persistence + incremental embedding for the org/memory lane.
//!
//! The org lane previously re-embedded the entire corpus (~11.8k items) on
//! every daemon warm-load because the documented `save_all` cache path was
//! never actually wired. This module supplies the missing layer:
//!
//! - [`OrgVecCache`] persists the usearch vector index (`vectors.uidx`) plus a
//!   sidecar manifest (`org_vec_meta.bin`) mapping each embedded item id to a
//!   content hash + the embedder model/dim it was produced under.
//! - On warm-load we [`OrgVecCache::load`] the prior index, then embed ONLY the
//!   items whose content hash changed (or are new); unchanged vectors are
//!   carried forward from the loaded index, and vanished ids are pruned.
//!
//! This is per-item incremental (no whole-repo fingerprint gate), so a single
//! edited `.org` file re-embeds just its items and an unchanged corpus embeds
//! nothing at all.
//!
//! Cache location: `pi_knowledge_core::cache::knowledge_cache_dir(repo_root)`
//! (already existed, previously unused by the worker). The personal store is
//! out of scope here — only the repo-scoped corpus is cached.

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
};

use pi_knowledge_core::{
	cache::knowledge_cache_dir,
	vec::{VectorEntry, VectorIndex, id_hash},
};
use pi_org_engine::OrgItem;
use serde::{Deserialize, Serialize};

/// Manifest sidecar persisted next to `vectors.uidx`. Bincode-encoded.
///
/// `entries` maps the stable usearch key (`id_hash(item.id)`) to the content
/// hash of the text that produced the stored vector. A warm-load compares the
/// freshly-computed content hash against this to decide reuse-vs-reembed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrgVecManifest {
	/// Bumped when the on-disk shape changes incompatibly.
	pub schema_version: u32,
	/// Embedder identity the vectors were produced under. A mismatch
	/// invalidates the whole cache (every vector must be recomputed).
	pub embedder_model: String,
	pub embedder_dim:   usize,
	/// `id_hash(item.id)` → content hash of the embedded text.
	pub entries:        BTreeMap<u64, u64>,
}

pub const ORG_VEC_SCHEMA_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "org_vec_meta.bin";
const VECTORS_NAME: &str = "vectors.uidx";


/// Stable content hash for an item's embedded text.
///
/// FNV-1a over the exact string that `build_vec_index_with` feeds the embedder,
/// so any title/body edit flips the hash and triggers a re-embed of just that
/// item.
#[must_use]
pub fn content_hash(text: &str) -> u64 {
	const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
	const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
	let mut h = FNV_OFFSET;
	for &b in text.as_bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(FNV_PRIME);
	}
	h
}

/// Embed text for one item: `"{title} {body[..512 chars]}"`. Kept here so the
/// cache content-hash and the embed input never drift apart.
#[must_use]
pub fn embed_text(item: &OrgItem) -> String {
	match item.body.as_ref() {
		Some(body) => format!("{} {}", item.title, body.chars().take(512).collect::<String>()),
		None => item.title.clone(),
	}
}

/// Handle to a repo's persisted org vector cache.
pub struct OrgVecCache {
	dir:            PathBuf,
	embedder_model: String,
	embedder_dim:   usize,
}

/// Outcome of loading a prior cache: the carried-forward index + the manifest
/// of which ids it already contains (by content hash).
pub struct LoadedCache {
	pub index:    VectorIndex,
	pub manifest: OrgVecManifest,
}

impl OrgVecCache {
	/// Resolve the cache dir for `repo_root`. Returns `None` (cache disabled,
	/// non-fatal) when the cache base cannot be determined.
	pub fn for_repo(repo_root: &Path, embedder_model: &str, embedder_dim: usize) -> Option<Self> {
		let dir = knowledge_cache_dir(repo_root).ok()?;
		Some(Self {
			dir,
			embedder_model: embedder_model.to_string(),
			embedder_dim,
		})
	}

	fn manifest_path(&self) -> PathBuf {
		self.dir.join(MANIFEST_NAME)
	}

	fn vectors_path(&self) -> PathBuf {
		self.dir.join(VECTORS_NAME)
	}

	/// Load the prior vector index + manifest, if present and compatible with
	/// the current embedder. A schema / model / dim mismatch returns `None`
	/// (treated as a cold cache — everything re-embeds).
	pub fn load(&self) -> Option<LoadedCache> {
		let manifest = read_manifest(&self.manifest_path())?;
		if manifest.schema_version != ORG_VEC_SCHEMA_VERSION
			|| manifest.embedder_model != self.embedder_model
			|| manifest.embedder_dim != self.embedder_dim
		{
			return None;
		}
		let index = VectorIndex::load(&self.vectors_path()).ok()?;
		if index.dim() != self.embedder_dim {
			return None;
		}
		Some(LoadedCache { index, manifest })
	}

	/// Persist `index` + a manifest describing `live` (`id_hash` → content hash).
	/// Best-effort: a write error is returned but is non-fatal to the lane.
	pub fn save(&self, index: &VectorIndex, live: &BTreeMap<u64, u64>) -> Result<(), String> {
		std::fs::create_dir_all(&self.dir).map_err(|e| format!("create cache dir: {e}"))?;
		// Vectors first, manifest last: a crash between the two leaves a
		// manifest-less (or stale-manifest) index that simply re-embeds, never
		// a manifest claiming vectors that aren't on disk.
		index
			.save(&self.vectors_path())
			.map_err(|e| format!("save vectors: {e}"))?;
		let manifest = OrgVecManifest {
			schema_version: ORG_VEC_SCHEMA_VERSION,
			embedder_model: self.embedder_model.clone(),
			embedder_dim:   self.embedder_dim,
			entries:        live.clone(),
		};
		write_manifest(&self.manifest_path(), &manifest)
	}

}

/// Partition `items` into reuse / embed / skip given a prior cache and an
/// optional recency cutoff.
///
/// - reuse: the loaded index contains the key AND the stored content hash
///   equals the freshly-computed one (unchanged item).
/// - embed: new or changed item within the recency window (must embed now).
/// - skip:  BUG-477 — item whose owning file is older than the recency cutoff
///   AND which has no carried-forward vector. It stays BM25 + graph
///   searchable; editing the file refreshes its mtime + content hash so the
///   next warm embeds it (the natural "embed-on-demand" path). A skipped item
///   that already had a cached vector is REUSED, never dropped — recency only
///   gates *new* embedding work, it never evicts existing vectors.
pub struct EmbedPlan<'a> {
	/// (key, item) pairs whose vectors carry forward unchanged.
	pub reuse: Vec<(u64, &'a OrgItem)>,
	/// (`key`, `item`, `embed_text`, `content_hash`) pairs needing a fresh embed.
	pub embed: Vec<(u64, &'a OrgItem, String, u64)>,
	/// Items intentionally left unembedded by the recency gate (lexical-only).
	pub skipped: Vec<&'a OrgItem>,
}

/// A file mtime cutoff in epoch-ms: items in files modified before this are
/// recency-skipped. `None` disables the gate (embed everything).
pub type RecencyCutoffMs = Option<u64>;

/// Read the recency cutoff from `KNOWLEDGE_EMBED_RECENCY_DAYS` (set by the
/// `knowledge { embed-recency-days N }` KDL knob via domain activation).
/// Returns `Some(cutoff_epoch_ms)` when a positive N is configured, else
/// `None` (gate disabled).
#[must_use]
pub fn recency_cutoff_from_env() -> RecencyCutoffMs {
	let days: u64 = std::env::var("KNOWLEDGE_EMBED_RECENCY_DAYS")
		.ok()
		.and_then(|v| v.parse().ok())
		.filter(|n| *n > 0)?;
	let now_ms = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |d| d.as_millis() as u64);
	let window_ms = days.saturating_mul(24 * 60 * 60 * 1000);
	Some(now_ms.saturating_sub(window_ms))
}

/// File mtime (epoch-ms) for an item's owning file. `0` when unavailable so a
/// missing/unreadable file is treated as "old" and recency-skipped.
fn item_file_mtime_ms(item: &OrgItem) -> u64 {
	std::fs::metadata(&item.file)
		.and_then(|m| m.modified())
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map_or(0, |d| d.as_millis() as u64)
}

#[must_use]
pub fn plan_embeds<'a>(items: &'a [OrgItem], prior: Option<&LoadedCache>) -> EmbedPlan<'a> {
	plan_embeds_with_recency(items, prior, None)
}

#[must_use]
pub fn plan_embeds_with_recency<'a>(
	items: &'a [OrgItem],
	prior: Option<&LoadedCache>,
	recency_cutoff_ms: RecencyCutoffMs,
) -> EmbedPlan<'a> {
	let mut reuse = Vec::new();
	let mut embed = Vec::new();
	let mut skipped = Vec::new();
	for item in items {
		let key = id_hash(&item.id);
		let text = embed_text(item);
		let hash = content_hash(&text);
		let reusable = prior.is_some_and(|p| {
			p.manifest.entries.get(&key) == Some(&hash) && p.index.contains(key)
		});
		if reusable {
			// Already embedded + unchanged — keep it regardless of recency.
			reuse.push((key, item));
			continue;
		}
		// New or changed. Apply the recency gate to *new* embedding work only.
		if let Some(cutoff) = recency_cutoff_ms
			&& item_file_mtime_ms(item) < cutoff
		{
			skipped.push(item);
		} else {
			embed.push((key, item, text, hash));
		}
	}
	EmbedPlan { reuse, embed, skipped }
}

fn read_manifest(path: &Path) -> Option<OrgVecManifest> {
	let bytes = std::fs::read(path).ok()?;
	bincode::deserialize(&bytes).ok()
}

fn write_manifest(path: &Path, manifest: &OrgVecManifest) -> Result<(), String> {
	let bytes = bincode::serialize(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
	let tmp = path.with_extension("bin.tmp");
	std::fs::write(&tmp, &bytes).map_err(|e| format!("write manifest tmp: {e}"))?;
	std::fs::rename(&tmp, path).map_err(|e| format!("rename manifest: {e}"))?;
	Ok(())
}

/// Carry a vector forward from `prior` into `dst` by key. No-op if absent.
pub fn carry_forward(dst: &mut VectorIndex, prior: &VectorIndex, key: u64) -> Result<(), String> {
	if let Some(vector) = prior.get(key) {
		dst.upsert(VectorEntry { node_id: key, vector })
			.map_err(|e| format!("carry-forward upsert: {e}"))?;
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use tempfile::TempDir;

	use super::*;

	fn item(id: &str, title: &str, body: &str) -> OrgItem {
		OrgItem {
			id:         id.to_string(),
			title:      title.to_string(),
			state:      String::new(),
			category:   String::new(),
			dir:        String::new(),
			file:       String::new(),
			line:       0,
			level:      1,
			properties: HashMap::new(),
			body:       Some(body.to_string()),
			clocks:     Vec::new(),
			byte_range: (0, 0),
			children:   Vec::new(),
			relations:  Vec::new(),
		}
	}

	#[test]
	fn content_hash_changes_with_text() {
		let a = item("X", "title", "body one");
		let b = item("X", "title", "body two");
		assert_ne!(content_hash(&embed_text(&a)), content_hash(&embed_text(&b)));
	}

	#[test]
	fn plan_embeds_all_when_no_prior() {
		let items = vec![item("A", "alpha", "a"), item("B", "beta", "b")];
		let plan = plan_embeds(&items, None);
		assert_eq!(plan.embed.len(), 2);
		assert!(plan.reuse.is_empty());
		assert!(plan.skipped.is_empty());
	}

	#[test]
	fn recency_gate_skips_old_files_embeds_recent() {
		use std::time::{Duration, SystemTime};

		let tmp = TempDir::new().unwrap();
		// Two items backed by real files so mtime is meaningful.
		let old_path = tmp.path().join("old.org");
		let new_path = tmp.path().join("new.org");
		std::fs::write(&old_path, "x").unwrap();
		std::fs::write(&new_path, "y").unwrap();
		// Backdate the old file ~100 days.
		let hundred_days_ago =
			SystemTime::now() - Duration::from_secs(100 * 24 * 60 * 60);
		let ft = filetime::FileTime::from_system_time(hundred_days_ago);
		filetime::set_file_mtime(&old_path, ft).unwrap();

		let mut old = item("OLD", "old", "o");
		old.file = old_path.to_string_lossy().into_owned();
		let mut fresh = item("NEW", "new", "n");
		fresh.file = new_path.to_string_lossy().into_owned();
		let items = vec![old, fresh];

		// Cutoff at 90 days: old (100d) skipped, new (just-written) embedded.
		let now_ms = SystemTime::now()
			.duration_since(SystemTime::UNIX_EPOCH)
			.unwrap()
			.as_millis() as u64;
		let cutoff = now_ms - 90 * 24 * 60 * 60 * 1000;
		let plan = plan_embeds_with_recency(&items, None, Some(cutoff));
		assert_eq!(plan.embed.len(), 1, "only the recent item embeds");
		assert_eq!(plan.embed[0].1.id, "NEW");
		assert_eq!(plan.skipped.len(), 1, "the old item is skipped");
		assert_eq!(plan.skipped[0].id, "OLD");

		// No cutoff → both embed (back-compat).
		let plan_all = plan_embeds_with_recency(&items, None, None);
		assert_eq!(plan_all.embed.len(), 2);
		assert!(plan_all.skipped.is_empty());
	}

	#[test]
	fn roundtrip_reuses_unchanged_reembeds_changed() {
		let tmp = TempDir::new().unwrap();
		// Point the cache base at the tempdir.
		unsafe { std::env::set_var("XDG_CACHE_HOME", tmp.path()) };
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();

		let cache = OrgVecCache::for_repo(&repo, "test-model", 4).expect("cache");
		let items = vec![item("A", "alpha", "a"), item("B", "beta", "b")];

		// First build: no prior → embed all, persist.
		let plan = plan_embeds(&items, None);
		assert_eq!(plan.embed.len(), 2);
		let mut index = VectorIndex::new(4, 2).unwrap();
		let mut live = BTreeMap::new();
		for (key, _item, _text, hash) in &plan.embed {
			index
				.upsert(VectorEntry { node_id: *key, vector: vec![1.0, 0.0, 0.0, 0.0] })
				.unwrap();
			live.insert(*key, *hash);
		}
		cache.save(&index, &live).unwrap();

		// Second build: B edited, A unchanged.
		let items2 = vec![item("A", "alpha", "a"), item("B", "beta", "CHANGED")];
		let prior = cache.load().expect("load prior");
		let plan2 = plan_embeds(&items2, Some(&prior));
		assert_eq!(plan2.reuse.len(), 1, "A reused");
		assert_eq!(plan2.embed.len(), 1, "B re-embedded");
		assert_eq!(plan2.reuse[0].1.id, "A");
		assert_eq!(plan2.embed[0].1.id, "B");

		unsafe { std::env::remove_var("XDG_CACHE_HOME") };
	}

	#[test]
	fn load_returns_none_on_model_mismatch() {
		let tmp = TempDir::new().unwrap();
		unsafe { std::env::set_var("XDG_CACHE_HOME", tmp.path()) };
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();

		let cache = OrgVecCache::for_repo(&repo, "model-a", 4).expect("cache");
		let mut index = VectorIndex::new(4, 1).unwrap();
		index
			.upsert(VectorEntry { node_id: 1, vector: vec![1.0, 0.0, 0.0, 0.0] })
			.unwrap();
		let mut live = BTreeMap::new();
		live.insert(1u64, 99u64);
		cache.save(&index, &live).unwrap();

		// Different model → cache must be rejected.
		let cache_b = OrgVecCache::for_repo(&repo, "model-b", 4).expect("cache");
		assert!(cache_b.load().is_none(), "model mismatch invalidates cache");

		unsafe { std::env::remove_var("XDG_CACHE_HOME") };
	}
}
