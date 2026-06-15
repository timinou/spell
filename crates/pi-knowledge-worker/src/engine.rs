//! `EmbeddingEngine` — fastembed bge-m3 wrapper with backend selection.
//!
//! Was `pi_code_vectors::EmbeddingEngine` until PLAN-310 W5 deleted that
//! crate. The wrapper is internal to the worker binary; the only consumer is
//! `main.rs`'s socket / stdio dispatch.

use std::{env, path::PathBuf, sync::Mutex};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use ort::ep::{ExecutionProvider, Vitis};
use serde::Serialize;

pub const EMBEDDER_MODEL: &str = "bge-m3";
pub const EMBEDDER_DIM: usize = 1024;

const BACKEND_ENV_VAR: &str = "PI_KNOWLEDGE_EMBED_BACKEND";
const VITIS_CACHE_ENV_VAR: &str = "PI_KNOWLEDGE_VITIS_CACHE_DIR";
const VITIS_PROVIDER: &str = "VitisAIExecutionProvider";
const VITIS_CACHE_KEY: &str = "spell-bge-m3";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedBackendMode {
	Auto,
	Cpu,
	Vitis,
	Off,
}

impl EmbedBackendMode {
	pub fn from_env() -> Result<Self, String> {
		match env::var(BACKEND_ENV_VAR) {
			Ok(value) => Self::parse(&value).map_err(|error| format!("{BACKEND_ENV_VAR}: {error}")),
			Err(env::VarError::NotPresent) => Ok(Self::Auto),
			Err(error) => Err(format!("{BACKEND_ENV_VAR}: {error}")),
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value.trim().to_ascii_lowercase().as_str() {
			"" | "auto" => Ok(Self::Auto),
			"cpu" => Ok(Self::Cpu),
			"vitis" | "npu" | "vitisai" | "vitis_ai" => Ok(Self::Vitis),
			"off" | "disabled" | "disable" | "0" | "false" => Ok(Self::Off),
			other => Err(format!(
				"unknown embedding backend {other:?}; expected auto, cpu, vitis/npu, or off",
			)),
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveBackend {
	Cpu,
	Vitis,
	Disabled,
	Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedderState {
	Probing,
	Ready,
	Degraded,
	Disabled,
	Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmbedderStatus {
	pub desired:  EmbedBackendMode,
	pub active:   ActiveBackend,
	pub state:    EmbedderState,
	pub model:    &'static str,
	pub dim:      usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub provider: Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub reason:   Option<String>,
}

impl EmbedderStatus {
	fn ready(
		desired: EmbedBackendMode,
		active: ActiveBackend,
		provider: Option<&'static str>,
	) -> Self {
		Self {
			desired,
			active,
			state: EmbedderState::Ready,
			model: EMBEDDER_MODEL,
			dim: EMBEDDER_DIM,
			provider,
			reason: None,
		}
	}

	fn degraded(desired: EmbedBackendMode, reason: impl Into<String>) -> Self {
		Self {
			desired,
			active: ActiveBackend::Cpu,
			state: EmbedderState::Degraded,
			model: EMBEDDER_MODEL,
			dim: EMBEDDER_DIM,
			provider: None,
			reason: Some(reason.into()),
		}
	}

	fn disabled(desired: EmbedBackendMode, reason: impl Into<String>) -> Self {
		Self {
			desired,
			active: ActiveBackend::Disabled,
			state: EmbedderState::Disabled,
			model: EMBEDDER_MODEL,
			dim: EMBEDDER_DIM,
			provider: None,
			reason: Some(reason.into()),
		}
	}

	pub fn error(desired: EmbedBackendMode, reason: impl Into<String>) -> Self {
		Self {
			desired,
			active: ActiveBackend::Unavailable,
			state: EmbedderState::Error,
			model: EMBEDDER_MODEL,
			dim: EMBEDDER_DIM,
			provider: None,
			reason: Some(reason.into()),
		}
	}

	pub fn uninitialized() -> Self {
		match EmbedBackendMode::from_env() {
			Ok(EmbedBackendMode::Off) => Self::disabled(EmbedBackendMode::Off, "embeddings disabled"),
			Ok(desired) => Self {
				desired,
				active: ActiveBackend::Unavailable,
				state: EmbedderState::Probing,
				model: EMBEDDER_MODEL,
				dim: EMBEDDER_DIM,
				provider: None,
				reason: None,
			},
			Err(error) => Self::error(EmbedBackendMode::Auto, error),
		}
	}
}

enum BackendRuntime {
	Fastembed { active: ActiveBackend, model: TextEmbedding },
	Disabled,
}

impl BackendRuntime {
	fn active(&self) -> ActiveBackend {
		match self {
			Self::Fastembed { active, .. } => *active,
			Self::Disabled => ActiveBackend::Disabled,
		}
	}

	fn embed(
		&mut self,
		documents: Vec<String>,
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>, String> {
		match self {
			Self::Fastembed { model, .. } => model
				.embed(documents, batch_size)
				.map_err(|e| e.to_string()),
			Self::Disabled => Err("embeddings disabled".to_string()),
		}
	}
}

/// Wraps fastembed's `TextEmbedding` for bge-m3 model lifecycle.
///
/// Thread-safe via internal `Mutex` since `TextEmbedding::embed` requires
/// `&mut self`.
pub struct EmbeddingEngine {
	desired:       EmbedBackendMode,
	show_progress: bool,
	backend:       Mutex<BackendRuntime>,
	status:        Mutex<EmbedderStatus>,
}

// SAFETY: `TextEmbedding` uses `ort::Session` internally which is `Send +
// Sync`. The `Mutex` wrapper provides exclusive access for the `&mut self`
// requirement.
unsafe impl Sync for EmbeddingEngine {}

impl EmbeddingEngine {
	/// Initialize with BAAI/bge-m3 (1024-dim, multilingual). Downloads the
	/// model (~1.2 GB on disk; ~2.5 GB resident) on first call if not
	/// already cached.
	pub fn new(show_progress: bool) -> Result<Self, String> {
		let desired = EmbedBackendMode::from_env()?;
		let (backend, status) = select_backend(
			desired,
			|| build_vitis_backend(show_progress),
			|| build_cpu_backend(show_progress),
			|| BackendRuntime::Disabled,
		)?;
		Ok(Self { desired, show_progress, backend: Mutex::new(backend), status: Mutex::new(status) })
	}

	pub fn status(&self) -> EmbedderStatus {
		self
			.status
			.lock()
			.map(|status| status.clone())
			.unwrap_or_else(|error| {
				EmbedderStatus::error(self.desired, format!("status mutex poisoned: {error}"))
			})
	}

	/// Embed a batch of documents. Returns `Vec<Vec<f32>>` of 1024-dim vectors.
	pub fn embed_batch(
		&self,
		documents: &[&str],
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>, String> {
		let docs: Vec<String> = documents.iter().map(|s| (*s).to_owned()).collect();
		self.embed_documents(docs, batch_size)
	}

	/// Embed a single query string.
	pub fn embed_query(&self, query: &str) -> Result<Vec<f32>, String> {
		let mut results = self.embed_documents(vec![query.to_owned()], None)?;
		if results.is_empty() {
			return Err("empty embedding result".into());
		}
		Ok(results.swap_remove(0))
	}

	fn embed_documents(
		&self,
		documents: Vec<String>,
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>, String> {
		let mut backend = self
			.backend
			.lock()
			.map_err(|e| format!("mutex poisoned: {e}"))?;
		match backend.embed(documents.clone(), batch_size) {
			Ok(vectors) => Ok(vectors),
			Err(error)
				if backend.active() == ActiveBackend::Vitis
					&& self.desired == EmbedBackendMode::Auto =>
			{
				let reason = format!("NPU inference failed; fell back to CPU: {error}");
				let mut cpu = build_cpu_backend(self.show_progress)
					.map_err(|cpu_error| format!("{reason}; CPU fallback failed: {cpu_error}"))?;
				let vectors = cpu.embed(documents, batch_size)?;
				*backend = cpu;
				self.set_status(EmbedderStatus::degraded(self.desired, reason));
				Ok(vectors)
			},
			Err(error) if backend.active() == ActiveBackend::Disabled => Err(error),
			Err(error) => {
				self.set_status(EmbedderStatus::error(self.desired, error.clone()));
				Err(error)
			},
		}
	}

	fn set_status(&self, status: EmbedderStatus) {
		if let Ok(mut slot) = self.status.lock() {
			*slot = status;
		}
	}
}

fn select_backend<T>(
	desired: EmbedBackendMode,
	build_vitis: impl FnOnce() -> Result<T, String>,
	build_cpu: impl FnOnce() -> Result<T, String>,
	build_disabled: impl FnOnce() -> T,
) -> Result<(T, EmbedderStatus), String> {
	match desired {
		EmbedBackendMode::Off => Ok((
			build_disabled(),
			EmbedderStatus::disabled(desired, "embeddings disabled by PI_KNOWLEDGE_EMBED_BACKEND=off"),
		)),
		EmbedBackendMode::Cpu => build_cpu()
			.map(|backend| (backend, EmbedderStatus::ready(desired, ActiveBackend::Cpu, None))),
		EmbedBackendMode::Vitis => build_vitis().map(|backend| {
			(backend, EmbedderStatus::ready(desired, ActiveBackend::Vitis, Some(VITIS_PROVIDER)))
		}),
		EmbedBackendMode::Auto => match build_vitis() {
			Ok(backend) => Ok((
				backend,
				EmbedderStatus::ready(desired, ActiveBackend::Vitis, Some(VITIS_PROVIDER)),
			)),
			Err(vitis_error) => build_cpu()
				.map(|backend| {
					(
						backend,
						EmbedderStatus::degraded(
							desired,
							format!("NPU unavailable; using CPU: {vitis_error}"),
						),
					)
				})
				.map_err(|cpu_error| {
					format!("NPU unavailable ({vitis_error}); CPU backend failed: {cpu_error}")
				}),
		},
	}
}

fn build_cpu_backend(show_progress: bool) -> Result<BackendRuntime, String> {
	let options = base_options(show_progress);
	let model = TextEmbedding::try_new(options).map_err(|e| e.to_string())?;
	Ok(BackendRuntime::Fastembed { active: ActiveBackend::Cpu, model })
}

fn build_vitis_backend(show_progress: bool) -> Result<BackendRuntime, String> {
	let vitis = Vitis::default()
		.with_cache_dir(vitis_cache_dir().to_string_lossy())
		.with_cache_key(VITIS_CACHE_KEY);
	if !vitis.supported_by_platform() {
		return Err("VitisAIExecutionProvider is not supported on this platform".into());
	}
	match vitis.is_available() {
		Ok(true) => {},
		Ok(false) => {
			return Err("VitisAIExecutionProvider is not available in the linked ONNX Runtime".into());
		},
		Err(error) => {
			return Err(format!("could not inspect VitisAIExecutionProvider availability: {error}"));
		},
	}

	let cache_dir = vitis_cache_dir();
	std::fs::create_dir_all(&cache_dir)
		.map_err(|error| format!("create Vitis cache dir {}: {error}", cache_dir.display()))?;
	let ep = vitis.build().error_on_failure();
	let options = base_options(show_progress).with_execution_providers(vec![ep]);
	let model = TextEmbedding::try_new(options).map_err(|e| e.to_string())?;
	Ok(BackendRuntime::Fastembed { active: ActiveBackend::Vitis, model })
}

fn base_options(show_progress: bool) -> TextInitOptions {
	TextInitOptions::new(EmbeddingModel::BGEM3).with_show_download_progress(show_progress)
}

fn vitis_cache_dir() -> PathBuf {
	if let Ok(value) = env::var(VITIS_CACHE_ENV_VAR) {
		return PathBuf::from(value);
	}
	if let Ok(value) = env::var("XDG_CACHE_HOME") {
		return PathBuf::from(value).join("spell").join("vitis-bge-m3");
	}
	if let Ok(value) = env::var("HOME") {
		return PathBuf::from(value)
			.join(".cache")
			.join("spell")
			.join("vitis-bge-m3");
	}
	env::temp_dir().join("spell-vitis-bge-m3")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_backend_modes() {
		assert_eq!(EmbedBackendMode::parse(""), Ok(EmbedBackendMode::Auto));
		assert_eq!(EmbedBackendMode::parse("auto"), Ok(EmbedBackendMode::Auto));
		assert_eq!(EmbedBackendMode::parse("cpu"), Ok(EmbedBackendMode::Cpu));
		assert_eq!(EmbedBackendMode::parse("npu"), Ok(EmbedBackendMode::Vitis));
		assert_eq!(EmbedBackendMode::parse("vitis"), Ok(EmbedBackendMode::Vitis));
		assert_eq!(EmbedBackendMode::parse("off"), Ok(EmbedBackendMode::Off));
		assert!(EmbedBackendMode::parse("gpu").is_err());
	}

	#[test]
	fn auto_degrades_to_cpu_when_vitis_unavailable() {
		let (backend, status) = select_backend(
			EmbedBackendMode::Auto,
			|| Err("provider missing".to_string()),
			|| Ok("cpu"),
			|| "disabled",
		)
		.expect("auto should fall back to cpu");
		assert_eq!(backend, "cpu");
		assert_eq!(status.desired, EmbedBackendMode::Auto);
		assert_eq!(status.active, ActiveBackend::Cpu);
		assert_eq!(status.state, EmbedderState::Degraded);
		assert!(
			status
				.reason
				.as_deref()
				.unwrap_or_default()
				.contains("provider missing")
		);
	}

	#[test]
	fn off_mode_succeeds_with_disabled_backend() {
		let (backend, status) = select_backend(
			EmbedBackendMode::Off,
			|| panic!("vitis should not be probed"),
			|| panic!("cpu should not be loaded"),
			|| "disabled",
		)
		.expect("off mode should still initialise daemon capabilities");
		assert_eq!(backend, "disabled");
		assert_eq!(status.active, ActiveBackend::Disabled);
		assert_eq!(status.state, EmbedderState::Disabled);
	}

	#[test]
	fn forced_vitis_fails_loud_when_unavailable() {
		let err = select_backend(
			EmbedBackendMode::Vitis,
			|| Err::<&'static str, _>("provider missing".to_string()),
			|| Ok("cpu"),
			|| "disabled",
		)
		.expect_err("forced vitis must not fall back");
		assert_eq!(err, "provider missing");
	}

	#[test]
	fn cpu_mode_never_probes_vitis() {
		let (backend, status) = select_backend(
			EmbedBackendMode::Cpu,
			|| panic!("vitis should not be probed"),
			|| Ok("cpu"),
			|| "disabled",
		)
		.expect("cpu mode should use cpu");
		assert_eq!(backend, "cpu");
		assert_eq!(status.active, ActiveBackend::Cpu);
		assert_eq!(status.state, EmbedderState::Ready);
	}
}
