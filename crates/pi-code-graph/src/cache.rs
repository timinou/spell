pub use pi_workspace_cache::{
	CacheStatus, CacheStore, FileFingerprint, PersistentCacheEntry,
	WorkspaceFingerprint as GraphFingerprint, read_git_head,
};
use serde::{Deserialize, Serialize};

use crate::model::{CodeGraph, PersistedCodeGraph};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphCacheEntry {
	pub graph:       PersistedCodeGraph,
	pub fingerprint: GraphFingerprint,
}

impl PersistentCacheEntry for GraphCacheEntry {
	fn fingerprint(&self) -> &GraphFingerprint {
		&self.fingerprint
	}
}

impl GraphCacheEntry {
	pub fn new(graph: CodeGraph, fingerprint: GraphFingerprint) -> Self {
		Self { graph: graph.into_persisted(), fingerprint }
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		fs,
		path::{Path, PathBuf},
	};

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{EdgeKind, GraphNode, GraphStats};

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
			.load::<GraphCacheEntry>("unit")
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
			.status::<GraphCacheEntry>("workspace", &root, &is_typescript_source)
			.expect("status should succeed");
		assert_eq!(status, CacheStatus::Fresh);
		let _ = fs::remove_dir_all(root);
	}
}
