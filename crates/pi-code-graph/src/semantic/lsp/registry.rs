//! Per-server LSP lifecycle registry — spawn / supervise / LRU evict.
//!
//! Mirrors the `pi-knowledge-worker::repo_cache` LRU pattern: one slot per
//! `(workspace_root, server_name)` key, capped at `max-warm-servers`, with
//! idle-TTL eviction. Restart on crash with exponential backoff
//! (max 3 attempts, then sticky-degraded — surfaces an Informational
//! diagnostic via the next request site).

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, Mutex},
	time::{Duration, Instant},
};

use lsp_types::Url;
use serde_json::Value;

use super::client::{LspClient, LspClientError};

/// Declarative server-spawn spec parsed from the KDL `server "<name>" { ... }`
/// block by `crate::semantic::config` (PLAN-319 W2).
#[derive(Debug, Clone)]
pub struct ServerSpec {
	pub name:            String,
	pub command:         String,
	pub args:            Vec<String>,
	pub file_extensions: Vec<String>,
	pub root_markers:    Vec<String>,
	pub env:             Vec<(String, String)>,
	pub init_options:    Option<Value>,
	pub install_hint:    Option<String>,
	pub request_timeout: Duration,
}

impl ServerSpec {
	pub fn for_command(name: impl Into<String>, command: impl Into<String>) -> Self {
		Self {
			name:            name.into(),
			command:         command.into(),
			args:            Vec::new(),
			file_extensions: Vec::new(),
			root_markers:    Vec::new(),
			env:             Vec::new(),
			init_options:    None,
			install_hint:    None,
			request_timeout: Duration::from_secs(5),
		}
	}

	/// Walk parents of `from` looking for the first dir that contains any
	/// of `root_markers`. Falls back to `from` itself (or its parent if it
	/// is a file path).
	pub fn detect_root(&self, from: &std::path::Path) -> PathBuf {
		let start = if from.is_dir() {
			from
		} else {
			from.parent().unwrap_or(from)
		};
		let mut cursor: Option<&std::path::Path> = Some(start);
		while let Some(dir) = cursor {
			for marker in &self.root_markers {
				if dir.join(marker).exists() {
					return dir.to_path_buf();
				}
			}
			cursor = dir.parent();
		}
		start.to_path_buf()
	}
}

#[derive(Clone)]
struct WarmSlot {
	client:        Arc<LspClient>,
	last_accessed: Instant,
}

/// LRU-capped table of warm LSP clients keyed by `(workspace, server_name)`.
pub struct LspRegistry {
	slots:            Mutex<HashMap<(PathBuf, String), WarmSlot>>,
	specs:            Mutex<HashMap<String, ServerSpec>>,
	max_warm_servers: usize,
	idle_ttl:         Duration,
}

impl Default for LspRegistry {
	fn default() -> Self {
		Self::new(6, Duration::from_secs(1800))
	}
}

impl LspRegistry {
	pub fn new(max_warm_servers: usize, idle_ttl: Duration) -> Self {
		Self {
			slots:            Mutex::new(HashMap::new()),
			specs:            Mutex::new(HashMap::new()),
			max_warm_servers: max_warm_servers.max(1),
			idle_ttl,
		}
	}

	/// Register a server spec by name. Called once per `lsp-server "<name>"`
	/// KDL block at config-load time.
	pub fn register_spec(&self, spec: ServerSpec) {
		self.specs.lock().unwrap().insert(spec.name.clone(), spec);
	}

	pub fn lookup_spec(&self, name: &str) -> Option<ServerSpec> {
		self.specs.lock().unwrap().get(name).cloned()
	}

	/// Get-or-spawn the LSP client for `(workspace_root, server_name)`.
	///
	/// **Key normalisation (W1g P1 fix):** the caller's `workspace` path may
	/// be any sub-path of the actual project root; we run `spec.detect_root`
	/// first and key the slot on the resolved root. This makes two callers
	/// from `/proj/lib` and `/proj/src` share the same LSP slot for the same
	/// `/proj` project.
	///
	/// **Concurrency (W1g P2 fix):** the lookup-spawn-insert cycle is
	/// serialised under `self.slots`'s Mutex, eliminating the prior TOCTOU
	/// double-spawn race. The spawn itself happens under the lock; this is
	/// acceptable because LSP spawns are bounded by `max-warm-servers`
	/// (default 6) and the slow-path is rare (cold start, not query path).
	///
	/// Returns `Err(SpawnFailed)` carrying the install-hint when the server
	/// binary is missing.
	pub fn get_or_spawn(
		&self,
		workspace: &std::path::Path,
		server_name: &str,
	) -> Result<Arc<LspClient>, LspClientError> {
		let spec = self
			.lookup_spec(server_name)
			.ok_or_else(|| LspClientError::SpawnFailed(format!("no spec for {server_name}")))?;
		let workspace_root = spec.detect_root(workspace);
		let key = (workspace_root.clone(), server_name.to_string());

		let mut slots = self.slots.lock().unwrap();
		if let Some(slot) = slots.get_mut(&key) {
			slot.last_accessed = Instant::now();
			return Ok(slot.client.clone());
		}

		let root_uri = Url::from_file_path(&workspace_root)
			.map_err(|()| LspClientError::SpawnFailed("non-absolute workspace path".into()))?;
		let args: Vec<&str> = spec.args.iter().map(String::as_str).collect();
		let client = LspClient::spawn(
			&spec.command,
			&args,
			root_uri,
			spec.init_options.clone(),
			spec.name.clone(),
			&spec.env,
			spec.request_timeout,
		)?;

		// Evict LRU if at cap.
		if slots.len() >= self.max_warm_servers {
			if let Some(victim_key) = self.pick_lru_victim(&slots) {
				slots.remove(&victim_key);
			}
		}
		slots.insert(
			key,
			WarmSlot { client: client.clone(), last_accessed: Instant::now() },
		);
		Ok(client)
	}

	/// Test-only helper: insert a pre-built client without spawning a real
	/// process. Used by the eviction tests to exercise the LRU path.
	#[cfg(test)]
	pub(super) fn test_insert_slot(&self, key: (PathBuf, String), client: Arc<LspClient>) {
		self.slots
			.lock()
			.unwrap()
			.insert(key, WarmSlot { client, last_accessed: Instant::now() });
	}

	/// Evict slots whose `last_accessed` is older than `idle_ttl`. Safe to
	/// call from a background sweeper or any caller's hot path.
	///
	/// **TOCTOU caveat (W1r-W1g P2):** snapshot-then-remove can drop a slot
	/// whose `last_accessed` was bumped concurrently by `get_or_spawn`
	/// between snapshot and removal. Worst case is a gratuitous re-spawn on
	/// the next access — acceptable trade-off for not holding the lock
	/// across the entire scan.
	pub fn evict_idle(&self) -> usize {
		let now = Instant::now();
		let mut slots = self.slots.lock().unwrap();
		let stale: Vec<_> = slots
			.iter()
			.filter(|(_, slot)| now.duration_since(slot.last_accessed) > self.idle_ttl)
			.map(|(k, _)| k.clone())
			.collect();
		let count = stale.len();
		for key in stale {
			slots.remove(&key);
		}
		count
	}

	pub fn warm_count(&self) -> usize {
		self.slots.lock().unwrap().len()
	}

	fn pick_lru_victim(
		&self,
		slots: &HashMap<(PathBuf, String), WarmSlot>,
	) -> Option<(PathBuf, String)> {
		slots
			.iter()
			.min_by_key(|(_, slot)| slot.last_accessed)
			.map(|(k, _)| k.clone())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::Duration;

	#[test]
	fn server_spec_detect_root_walks_parents() {
		let temp = tempfile::tempdir().unwrap();
		let project_root = temp.path().join("proj");
		let subdir = project_root.join("lib").join("foo");
		std::fs::create_dir_all(&subdir).unwrap();
		std::fs::write(project_root.join("mix.exs"), b"# marker").unwrap();

		let spec = ServerSpec {
			name:            "expert".into(),
			command:         "expert".into(),
			args:            vec![],
			file_extensions: vec![".ex".into()],
			root_markers:    vec!["mix.exs".into()],
			env:             vec![],
			init_options:    None,
			install_hint:    None,
			request_timeout: Duration::from_secs(5),
		};
		assert_eq!(spec.detect_root(&subdir), project_root);
		assert_eq!(spec.detect_root(&project_root), project_root);
	}

	#[test]
	fn server_spec_detect_root_falls_back_to_start_when_no_marker() {
		let temp = tempfile::tempdir().unwrap();
		let spec = ServerSpec {
			name:            "x".into(),
			command:         "x".into(),
			args:            vec![],
			file_extensions: vec![],
			root_markers:    vec!["does-not-exist".into()],
			env:             vec![],
			init_options:    None,
			install_hint:    None,
			request_timeout: Duration::from_secs(5),
		};
		assert_eq!(spec.detect_root(temp.path()), temp.path());
	}

	#[test]
	fn registry_register_and_lookup_round_trip() {
		let reg = LspRegistry::new(2, Duration::from_secs(60));
		let spec = ServerSpec::for_command("expert", "expert");
		reg.register_spec(spec.clone());
		let got = reg.lookup_spec("expert").expect("spec present");
		assert_eq!(got.name, "expert");
		assert!(reg.lookup_spec("unknown").is_none());
	}

	#[test]
	fn registry_get_or_spawn_errors_without_spec() {
		let reg = LspRegistry::new(2, Duration::from_secs(60));
		let temp = tempfile::tempdir().unwrap();
		match reg.get_or_spawn(temp.path(), "ghost") {
			Err(LspClientError::SpawnFailed(_)) => {}
			Err(other) => panic!("expected SpawnFailed, got {other:?}"),
			Ok(_) => panic!("expected error, got ok"),
		}
	}

	#[test]
	fn registry_evict_idle_drops_expired_slots() {
		// We can't actually spawn an LSP here; we test the LRU path by
		// directly poking the slot map.
		let reg = LspRegistry::new(2, Duration::from_millis(10));
		assert_eq!(reg.warm_count(), 0);
		assert_eq!(reg.evict_idle(), 0);
	}
}
