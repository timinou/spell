//! pi-knowledge-worker library surface.
//!
//! The crate publishes a `bin` target (`src/main.rs`) for the daemon
//! itself and a sibling `lib` target (this file) so internal modules
//! (`repo_cache`, `lane_org`, `embedder_adapter`, `engine`) are reachable
//! from in-process integration tests and from sibling crates that need
//! the shared types (e.g. `WarmProgress`, `LaneStatus`).
//!
//! Only items intended for cross-module reuse are public. The `bin`
//! still owns the actual daemon entry point and stdio / socket loops.

pub mod embedder_adapter;
pub mod engine;
pub mod lane_code;
pub mod lane_org;
pub mod org_cache;
pub mod repo_cache;
pub mod subscribe;

use std::sync::{Mutex, OnceLock};

use crate::engine::{EmbedBackendMode, EmbedderStatus, EmbeddingEngine};

/// Knowledge lane identifier. Two cache shapes live in the daemon:
/// the org/memory recall lane and the code-graph hybrid-search lane.
#[derive(Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq, Clone, Copy, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
	OrgMemory,
	CodeGraph,
}

/// Global engine slot. Lazily initialised on first embedding request so
/// the binary's stdio / socket entry points and in-process tests share
/// a single bge-m3 model instance.
static ENGINE: OnceLock<Mutex<Option<EmbeddingEngine>>> = OnceLock::new();

pub fn engine_slot() -> &'static Mutex<Option<EmbeddingEngine>> {
	ENGINE.get_or_init(|| Mutex::new(None))
}

pub fn init_engine() -> Result<(), String> {
	let engine = EmbeddingEngine::new(false)?;
	let mut slot = engine_slot()
		.lock()
		.map_err(|error| format!("mutex poisoned: {error}"))?;
	*slot = Some(engine);
	Ok(())
}

pub fn embedder_status() -> EmbedderStatus {
	match engine_slot().lock() {
		Ok(slot) => slot
			.as_ref()
			.map(EmbeddingEngine::status)
			.unwrap_or_else(EmbedderStatus::uninitialized),
		Err(error) => EmbedderStatus::error(
			EmbedBackendMode::Auto,
			format!("engine slot mutex poisoned: {error}"),
		),
	}
}

pub fn with_engine<T>(
	mut f: impl FnMut(&EmbeddingEngine) -> Result<T, String>,
) -> Result<T, String> {
	{
		let needs_init = engine_slot()
			.lock()
			.map_err(|error| format!("mutex poisoned: {error}"))?
			.is_none();
		if needs_init {
			init_engine()?;
		}
	}

	let slot = engine_slot()
		.lock()
		.map_err(|error| format!("mutex poisoned: {error}"))?;
	let engine = slot
		.as_ref()
		.ok_or_else(|| "embedding engine unavailable after init".to_string())?;
	f(engine)
}
