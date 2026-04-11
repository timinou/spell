use std::sync::Arc;

use arc_swap::ArcSwapOption;

use crate::model::CodeGraph;

#[derive(Default)]
pub struct GraphStore {
	current: ArcSwapOption<CodeGraph>,
}

impl GraphStore {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn load(&self) -> Option<Arc<CodeGraph>> {
		self.current.load_full()
	}

	pub fn replace(&self, graph: Arc<CodeGraph>) {
		self.current.store(Some(graph));
	}

	pub fn clear(&self) {
		self.current.store(None);
	}
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{EdgeKind, GraphNode, GraphStats, PersistedCodeGraph};

	#[test]
	fn store_swaps_snapshots_atomically() {
		let store = GraphStore::new();
		let graph = Arc::new(CodeGraph::from(PersistedCodeGraph {
			root:            PathBuf::from("."),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 0,
			git_head:        None,
		}));
		store.replace(graph.clone());
		let current = store.load().expect("graph should exist");
		assert!(Arc::ptr_eq(&current, &graph));
		store.clear();
		assert!(store.load().is_none());
	}
}
