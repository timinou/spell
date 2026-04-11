use std::{
	collections::BTreeMap,
	fs,
	io::{BufReader, BufWriter},
	path::{Path, PathBuf},
	time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

use crate::{
	error::{CodeGraphError, Result},
	model::{CodeGraph, PersistedCodeGraph},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct FileFingerprint {
	pub size:           u64,
	pub modified_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct GraphFingerprint {
	pub root:     PathBuf,
	pub git_head: Option<String>,
	pub files:    BTreeMap<PathBuf, FileFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphCacheEntry {
	pub graph:       PersistedCodeGraph,
	pub fingerprint: GraphFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheStatus {
	Missing,
	Fresh,
	Stale { reason: String },
}

#[derive(Debug, Clone)]
pub struct CacheStore {
	directory: PathBuf,
}

impl CacheStore {
	pub fn new(directory: impl Into<PathBuf>) -> Self {
		Self { directory: directory.into() }
	}

	pub fn directory(&self) -> &Path {
		&self.directory
	}

	pub fn entry_path(&self, name: &str) -> PathBuf {
		self.directory.join(format!("{name}.bin"))
	}

	pub fn load(&self, name: &str) -> Result<Option<GraphCacheEntry>> {
		let path = self.entry_path(name);
		if !path.exists() {
			return Ok(None);
		}
		let file = fs::File::open(path)?;
		let reader = BufReader::new(file);
		let entry = bincode::deserialize_from(reader)?;
		Ok(Some(entry))
	}

	pub fn save(&self, name: &str, entry: &GraphCacheEntry) -> Result<()> {
		fs::create_dir_all(&self.directory)?;
		let path = self.entry_path(name);
		let file = fs::File::create(path)?;
		let writer = BufWriter::new(file);
		bincode::serialize_into(writer, entry)?;
		Ok(())
	}

	pub fn fingerprint_root(
		&self,
		root: &Path,
		matches_source: &dyn Fn(&Path) -> bool,
	) -> Result<GraphFingerprint> {
		if !root.is_dir() {
			return Err(CodeGraphError::InvalidRoot(root.to_path_buf()));
		}
		let mut files = BTreeMap::new();
		for entry in ignore::WalkBuilder::new(root)
			.hidden(false)
			.git_ignore(true)
			.git_exclude(true)
			.build()
		{
			let entry =
				entry.map_err(|error| CodeGraphError::Io(std::io::Error::other(error.to_string())))?;
			if !entry
				.file_type()
				.is_some_and(|file_type| file_type.is_file())
			{
				continue;
			}
			let path = entry.into_path();
			let relative = path
				.strip_prefix(root)
				.unwrap_or(path.as_path())
				.to_path_buf();
			if relative.starts_with(".spell") || !matches_source(&path) {
				continue;
			}
			let metadata = fs::metadata(&path)?;
			files.insert(relative, FileFingerprint::from_metadata(&metadata)?);
		}
		Ok(GraphFingerprint { root: root.to_path_buf(), git_head: read_git_head(root), files })
	}

	pub fn status(
		&self,
		name: &str,
		root: &Path,
		matches_source: &dyn Fn(&Path) -> bool,
	) -> Result<CacheStatus> {
		let Some(entry) = self.load(name)? else {
			return Ok(CacheStatus::Missing);
		};
		let current = self.fingerprint_root(root, matches_source)?;
		if entry.fingerprint.git_head != current.git_head {
			return Ok(CacheStatus::Stale { reason: "git HEAD changed".into() });
		}
		if entry.fingerprint.files != current.files {
			return Ok(CacheStatus::Stale { reason: "workspace files changed".into() });
		}
		Ok(CacheStatus::Fresh)
	}
}

impl FileFingerprint {
	pub fn from_metadata(metadata: &fs::Metadata) -> Result<Self> {
		let modified_at_ms = metadata
			.modified()?
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64;
		Ok(Self { size: metadata.len(), modified_at_ms })
	}
}

pub fn read_git_head(root: &Path) -> Option<String> {
	let git_dir = root.join(".git");
	let head_path = git_dir.join("HEAD");
	let head = fs::read_to_string(head_path).ok()?;
	let trimmed = head.trim();
	if let Some(reference) = trimmed.strip_prefix("ref: ") {
		let ref_path = git_dir.join(reference);
		fs::read_to_string(ref_path)
			.ok()
			.map(|value| value.trim().to_string())
	} else {
		Some(trimmed.to_string())
	}
}

impl GraphCacheEntry {
	pub fn new(graph: CodeGraph, fingerprint: GraphFingerprint) -> Self {
		Self { graph: graph.into_persisted(), fingerprint }
	}
}

#[cfg(test)]
mod tests {
	use std::path::{Path, PathBuf};

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{EdgeKind, GraphNode, GraphStats, PersistedCodeGraph};

	fn temp_dir(name: &str) -> PathBuf {
		std::env::temp_dir().join(format!("pi-code-graph-{name}-{}", std::process::id()))
	}

	fn is_typescript_source(path: &Path) -> bool {
		path.extension().and_then(|extension| extension.to_str()) == Some("ts")
	}

	#[test]
	fn cache_round_trip_preserves_graph() {
		let temp_dir = temp_dir("cache");
		let _ = fs::remove_dir_all(&temp_dir);
		fs::create_dir_all(&temp_dir).expect("temp dir should be created");

		let store = CacheStore::new(&temp_dir);
		let graph = PersistedCodeGraph {
			root:            PathBuf::from("/tmp/project"),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 42,
			git_head:        Some("abc123".into()),
		};
		let entry = GraphCacheEntry {
			graph,
			fingerprint: GraphFingerprint {
				root:     PathBuf::from("/tmp/project"),
				git_head: Some("abc123".into()),
				files:    BTreeMap::new(),
			},
		};
		store.save("unit", &entry).expect("save should succeed");
		let loaded = store
			.load("unit")
			.expect("load should succeed")
			.expect("entry should exist");
		assert_eq!(loaded.graph.generated_at_ms, 42);
		let _ = fs::remove_dir_all(temp_dir);
	}

	#[test]
	fn cache_fingerprint_excludes_non_source_files() {
		let root = temp_dir("cache-fingerprint-root");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join(".spell/graph")).expect("cache dir should be created");
		fs::write(root.join("foo.ts"), "export const foo = 1;")
			.expect("source file should be written");
		fs::write(root.join("README.md"), "docs").expect("markdown file should be written");
		fs::write(root.join(".spell/graph/workspace.bin"), "cache")
			.expect("cache file should be written");

		let store = CacheStore::new(root.join(".spell/graph"));
		let fingerprint = store
			.fingerprint_root(&root, &is_typescript_source)
			.expect("fingerprint should succeed");
		let files = fingerprint.files.keys().cloned().collect::<Vec<_>>();
		assert_eq!(files, vec![PathBuf::from("foo.ts")]);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn cache_status_ignores_non_source_changes() {
		let root = temp_dir("cache-status-root");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join(".spell/graph")).expect("cache dir should be created");
		fs::write(root.join("foo.ts"), "export const foo = 1;")
			.expect("source file should be written");

		let store = CacheStore::new(root.join(".spell/graph"));
		let fingerprint = store
			.fingerprint_root(&root, &is_typescript_source)
			.expect("fingerprint should succeed");
		let graph = CodeGraph::from(PersistedCodeGraph {
			root:            root.clone(),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 1,
			git_head:        fingerprint.git_head.clone(),
		});
		store
			.save("workspace", &GraphCacheEntry::new(graph, fingerprint))
			.expect("cache save should succeed");

		fs::write(root.join("README.md"), "docs change").expect("markdown file should be written");

		let status = store
			.status("workspace", &root, &is_typescript_source)
			.expect("status should succeed");
		assert_eq!(status, CacheStatus::Fresh);
		let _ = fs::remove_dir_all(root);
	}
}
