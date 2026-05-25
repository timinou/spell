//! Persistence surface. Re-export of `pi-workspace-cache`.
//!
//! Decision (PLAN-310 W1.5): re-export rather than absorb. `pi-workspace-cache`
//! already ships the fingerprint + atomic-rename + bincode shape we need;
//! co-locating the import path inside `pi-knowledge-core` is the only ask
//! this wave.

pub use pi_workspace_cache::{
	CacheStatus, CacheStore, FileFingerprint, PersistentCacheEntry,
	WorkspaceCacheError, WorkspaceFingerprint, fingerprint_root, read_git_head,
};

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Increment when the persisted cache shape changes in a non-backwards-compatible way.
/// W5 ingest checks this on load and discards the cache dir if it doesn't match.
///
/// History:
/// - v1: initial KnowledgeMeta-gated shape.
/// - v2 (PLAN-319 W0): `pi-knowledge-core::bm25::SearchIndex` switched to
///   tombstone-bearing `Vec<Option<SearchDocument>>` storage + new
///   `id_to_index` / `total_tokens` / `live_count` fields. Old bm25.bin
///   blobs are not decode-compatible; the meta check rejects them before
///   the bincode load is attempted.
pub const KNOWLEDGE_SCHEMA_VERSION: u32 = 2;

/// Lightweight metadata entry stored alongside the heavy bin files (bm25.bin,
/// graph.bin, vectors.uidx, items.bin). The W5 ingest module reads this first
/// and refuses to load the rest on mismatch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnowledgeMeta {
	pub schema_version: u32,
	pub fingerprint:    WorkspaceFingerprint,
	/// ISO8601 instant of last successful build.
	pub built_at:       String,
	/// Embedder model name (W3 onward; "" until then).
	pub embedder_model: String,
	/// Embedder dimensionality (1024 for bge-m3; 0 until then).
	pub embedder_dim:   usize,
}

impl KnowledgeMeta {
	pub fn new(fingerprint: WorkspaceFingerprint) -> Self {
		Self {
			schema_version: KNOWLEDGE_SCHEMA_VERSION,
			fingerprint,
			built_at:       chrono_iso_now(),
			embedder_model: String::new(),
			embedder_dim:   0,
		}
	}

	/// Returns `CacheStatus::Stale` on schema mismatch, embedder mismatch, or fingerprint mismatch.
	pub fn status_against(
		&self,
		current: &WorkspaceFingerprint,
		expected_model: &str,
		expected_dim: usize,
	) -> CacheStatus {
		if self.schema_version != KNOWLEDGE_SCHEMA_VERSION {
			return CacheStatus::Stale {
				reason: format!(
					"schema version {} != current {}",
					self.schema_version, KNOWLEDGE_SCHEMA_VERSION,
				),
			};
		}
		if !expected_model.is_empty()
			&& (self.embedder_model != expected_model || self.embedder_dim != expected_dim)
		{
			return CacheStatus::Stale {
				reason: format!(
					"embedder {}/{} != current {}/{}",
					self.embedder_model, self.embedder_dim, expected_model, expected_dim,
				),
			};
		}
		if self.fingerprint.git_head != current.git_head {
			return CacheStatus::Stale { reason: "git HEAD changed".into() };
		}
		if self.fingerprint.files != current.files {
			return CacheStatus::Stale { reason: "workspace files changed".into() };
		}
		CacheStatus::Fresh
	}
}

impl PersistentCacheEntry for KnowledgeMeta {
	fn fingerprint(&self) -> &WorkspaceFingerprint {
		&self.fingerprint
	}
}

/// Compute the cache directory for a given repo root.
///
/// Hash the canonicalised path the same way `pi-org-recall` did (`Sha256`
/// truncated to 12 hex chars) for one-shot continuity — W5 will create
/// directories under this path.
pub fn knowledge_cache_dir(repo_root: &std::path::Path) -> crate::Result<PathBuf> {
	let base = dirs_cache_base()?;
	let hash = repo_hash(repo_root)?;
	Ok(base.join("knowledge").join(hash))
}

/// Personal-store cache directory. `~/.cache/spell/knowledge/personal`
pub fn personal_cache_dir() -> crate::Result<PathBuf> {
	Ok(dirs_cache_base()?.join("knowledge").join("personal"))
}

fn dirs_cache_base() -> crate::Result<PathBuf> {
	std::env::var("XDG_CACHE_HOME")
		.ok()
		.map(PathBuf::from)
		.or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".cache")))
		.map(|p| p.join("spell"))
		.ok_or_else(|| crate::Error::Other("neither XDG_CACHE_HOME nor HOME set".into()))
}

/// Compute a stable hash of the canonicalised repo root path.
///
/// Uses FNV-1a 64-bit (hex-encoded, 12 chars). Stable across Rust toolchain
/// versions — `std::hash::DefaultHasher` is explicitly documented as unstable.
///
/// Stability test — do not change the input/output unless you intend to
/// invalidate all caches.
fn repo_hash(repo_root: &std::path::Path) -> crate::Result<String> {
	let canon = std::fs::canonicalize(repo_root)?;
	let mut h: u64 = 0xcbf29ce484222325;
	for b in canon.to_string_lossy().bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(0x100000001b3);
	}
	Ok(format!("{h:012x}"))
}
/// Atomically save multiple cache entries.
///
/// Each entry is first written to `<name>.tmp` under the store directory;
/// only after every write succeeds are the files renamed into place. The order
/// is preserved as supplied by the caller — *callers SHOULD pass `meta` last*
/// so a crash between blobs leaves a half-written cache that fails the
/// `KnowledgeMeta::status_against` check rather than appearing Fresh atop stale
/// blobs.
///
/// On any write failure, all staged `.tmp` files are removed (best-effort) and
/// the error is returned.
pub fn save_all<I, F>(store: &CacheStore, entries: I) -> crate::Result<()>
where
	I: IntoIterator<Item = (&'static str, F)>,
	F: FnOnce(&mut std::io::BufWriter<std::fs::File>) -> crate::Result<()>,
{
	let entries: Vec<_> = entries.into_iter().collect();
	let dir = store.directory();
	std::fs::create_dir_all(dir)?;

	let staged: Vec<(std::path::PathBuf, std::path::PathBuf)> = entries
		.iter()
		.map(|(name, _)| {
			let final_path = dir.join(format!("{name}.bin"));
			let tmp_path = dir.join(format!("{name}.bin.tmp"));
			(tmp_path, final_path)
		})
		.collect();

	// Phase 1: write every blob to .tmp.
	for ((tmp, _), (_, writer_fn)) in staged.iter().zip(entries) {
		let write_result = (|| -> crate::Result<()> {
			let file = std::fs::File::create(tmp)?;
			let mut bw = std::io::BufWriter::new(file);
			writer_fn(&mut bw)?;
			bw.into_inner()
				.map_err(|e| crate::Error::Io(e.into_error()))?
				.sync_all()?;
			Ok(())
		})();
		if let Err(e) = write_result {
			// Clean up every staged tmp file on any write failure.
			for (t, _) in &staged {
				let _ = std::fs::remove_file(t);
			}
			return Err(e);
		}
	}

	// Phase 2: rename in caller-supplied order. Rename is atomic on POSIX.
	for (tmp, final_path) in &staged {
		std::fs::rename(tmp, final_path)?;
	}
	Ok(())
}
fn chrono_iso_now() -> String {
	chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		path::PathBuf,
	};

	use super::*;

	fn dummy_fingerprint() -> WorkspaceFingerprint {
		WorkspaceFingerprint {
			root:     PathBuf::from("/tmp/project"),
			git_head: Some("abc123".into()),
			files:    BTreeMap::new(),
		}
	}

	#[test]
	fn knowledge_meta_status_fresh() {
		let fp = dummy_fingerprint();
		let meta = KnowledgeMeta::new(fp.clone());
		assert_eq!(meta.status_against(&fp, "", 0), CacheStatus::Fresh);
	}

	#[test]
	fn knowledge_meta_status_stale_on_schema_bump() {
		let fp = dummy_fingerprint();
		let mut meta = KnowledgeMeta::new(fp.clone());
		meta.schema_version = 0;
		assert_eq!(
			meta.status_against(&fp, "", 0),
			CacheStatus::Stale {
				reason: format!("schema version 0 != current {KNOWLEDGE_SCHEMA_VERSION}"),
			},
		);
	}

	/// PLAN-319 W0 regression: persisted caches written with the pre-incremental
	/// `SearchIndex` shape (schema v1) MUST be rejected before bm25.bin is
	/// decoded, because the new tombstone-bearing `Vec<Option<SearchDocument>>`
	/// shape is not bincode-decode-compatible with the v1 `Vec<SearchDocument>`.
	#[test]
	fn knowledge_meta_status_rejects_v1_caches() {
		assert_eq!(KNOWLEDGE_SCHEMA_VERSION, 2, "expected v2 after PLAN-319 W0");
		let fp = dummy_fingerprint();
		let mut stale = KnowledgeMeta::new(fp.clone());
		stale.schema_version = 1; // pre-PLAN-319 cache shape
		assert_eq!(
			stale.status_against(&fp, "", 0),
			CacheStatus::Stale {
				reason: "schema version 1 != current 2".into(),
			},
			"v1 caches must be rejected so bm25.bin is never decoded against the new shape",
		);
	}

	#[test]
	fn knowledge_meta_status_stale_on_files() {
		let fp = dummy_fingerprint();
		let meta = KnowledgeMeta::new(fp.clone());
		let mut current = fp;
		current.files.insert(
			PathBuf::from("new.rs"),
			FileFingerprint { size: 1, modified_at_ms: 1 },
		);
		assert_eq!(
			meta.status_against(&current, "", 0),
			CacheStatus::Stale { reason: "workspace files changed".into() },
		);
	}

	#[test]
	fn knowledge_meta_status_stale_on_git_head() {
		let fp = dummy_fingerprint();
		let meta = KnowledgeMeta::new(fp.clone());
		let mut current = fp;
		current.git_head = Some("def456".into());
		assert_eq!(
			meta.status_against(&current, "", 0),
			CacheStatus::Stale { reason: "git HEAD changed".into() },
		);
	}

	#[test]
	fn status_stale_on_embedder_model_change() {
		let fp = dummy_fingerprint();
		let mut meta = KnowledgeMeta::new(fp.clone());
		meta.embedder_model = "bge-m3".into();
		meta.embedder_dim = 1024;
		let status = meta.status_against(&fp, "jina-v2", 1024);
		assert!(
			matches!(status, CacheStatus::Stale { ref reason } if reason.contains("bge-m3") && reason.contains("jina-v2")),
			"expected Stale with both model names, got {:?}",
			status
		);
	}

	#[test]
	fn status_stale_on_embedder_dim_change() {
		let fp = dummy_fingerprint();
		let mut meta = KnowledgeMeta::new(fp.clone());
		meta.embedder_model = "bge-m3".into();
		meta.embedder_dim = 1024;
		assert_eq!(
			meta.status_against(&fp, "bge-m3", 768),
			CacheStatus::Stale {
				reason: "embedder bge-m3/1024 != current bge-m3/768".into(),
			},
		);
	}

	#[test]
	fn status_ignores_embedder_when_expected_is_empty() {
		let fp = dummy_fingerprint();
		let mut meta = KnowledgeMeta::new(fp.clone());
		meta.embedder_model = "bge-m3".into();
		meta.embedder_dim = 1024;
		assert_eq!(meta.status_against(&fp, "", 0), CacheStatus::Fresh);
	}

	fn with_xdg_cache<F, R>(value: Option<&str>, f: F) -> R
	where
		F: FnOnce() -> R,
	{
		let old = std::env::var("XDG_CACHE_HOME").ok();
		match value {
			Some(v) => unsafe { std::env::set_var("XDG_CACHE_HOME", v) },
			None => unsafe { std::env::remove_var("XDG_CACHE_HOME") },
		}
		let result = f();
		match old {
			Some(v) => unsafe { std::env::set_var("XDG_CACHE_HOME", v) },
			None => unsafe { std::env::remove_var("XDG_CACHE_HOME") },
		}
		result
	}

	fn with_home<F, R>(value: &str, f: F) -> R
	where
		F: FnOnce() -> R,
	{
		let old = std::env::var("HOME").ok();
		unsafe { std::env::set_var("HOME", value) };
		let result = f();
		match old {
			Some(v) => unsafe { std::env::set_var("HOME", v) },
			None => unsafe { std::env::remove_var("HOME") },
		}
		result
	}

	#[test]
	fn knowledge_cache_dir_respects_xdg() {
		let tmp = tempfile::TempDir::new().unwrap();
		let xdg = tmp.path().to_str().unwrap();
		let repo = tmp.path().join("repo");
		std::fs::create_dir(&repo).unwrap();

		let path = with_xdg_cache(Some(xdg), || {
			knowledge_cache_dir(&repo).unwrap()
		});
		assert!(path.starts_with(xdg));
		assert!(path.components().any(|c| c.as_os_str() == "knowledge"));
	}

	#[test]
	fn personal_cache_dir_no_repo_dependency() {
		let tmp = tempfile::TempDir::new().unwrap();
		let home = tmp.path().to_str().unwrap();

		let path = with_xdg_cache(None, || with_home(home, || personal_cache_dir().unwrap()));
		assert_eq!(
			path,
			PathBuf::from(home).join(".cache").join("spell").join("knowledge").join("personal")
		);
	}

	#[test]
	fn repo_hash_is_stable_across_calls() {
		let tmp = tempfile::TempDir::new().unwrap();
		let a = repo_hash(tmp.path()).unwrap();
		let b = repo_hash(tmp.path()).unwrap();
		assert_eq!(a, b);
	}

	#[test]
	fn repo_hash_distinct_for_distinct_paths() {
		let a = tempfile::TempDir::new().unwrap();
		let b = tempfile::TempDir::new().unwrap();
		let ha = repo_hash(a.path()).unwrap();
		let hb = repo_hash(b.path()).unwrap();
		assert_ne!(ha, hb);
	}

	#[test]
	fn save_all_writes_all_blobs_atomically() {
		use std::io::Write;
		let tmp = tempfile::TempDir::new().unwrap();
		let store = CacheStore::new(tmp.path());
		save_all(
			&store,
			vec![
				(
					"a",
					Box::new(|w: &mut std::io::BufWriter<std::fs::File>| {
						w.write_all(b"a-payload")?;
						Ok(())
					})
						as Box<dyn FnOnce(&mut std::io::BufWriter<std::fs::File>) -> crate::Result<()>>,
				),
				(
					"meta",
					Box::new(|w: &mut std::io::BufWriter<std::fs::File>| {
						w.write_all(b"meta-payload")?;
						Ok(())
					})
						as Box<dyn FnOnce(&mut std::io::BufWriter<std::fs::File>) -> crate::Result<()>>,
				),
			],
		)
		.unwrap();
		assert!(store.directory().join("a.bin").exists());
		assert!(store.directory().join("meta.bin").exists());
		assert!(
			!store.directory().join("a.bin.tmp").exists(),
			"tmp cleaned up"
		);
	}

	#[test]
	fn save_all_cleans_up_tmp_on_failure() {
		use std::io::Write;
		let tmp = tempfile::TempDir::new().unwrap();
		let store = CacheStore::new(tmp.path());
		let err = save_all(
			&store,
			vec![
				(
					"a",
					Box::new(|w: &mut std::io::BufWriter<std::fs::File>| {
						w.write_all(b"a")?;
						Ok(())
					})
						as Box<dyn FnOnce(&mut std::io::BufWriter<std::fs::File>) -> crate::Result<()>>,
				),
				(
					"b",
					Box::new(|_w: &mut std::io::BufWriter<std::fs::File>| {
						Err(crate::Error::Other("forced failure".into()))
					})
						as Box<dyn FnOnce(&mut std::io::BufWriter<std::fs::File>) -> crate::Result<()>>,
				),
			],
		);
		assert!(err.is_err());
		assert!(!store.directory().join("a.bin").exists(), "no partial commit");
		assert!(!store.directory().join("a.bin.tmp").exists(), "tmp cleaned");
	}
}
