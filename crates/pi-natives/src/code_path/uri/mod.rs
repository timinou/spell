//! URI scheme registry and handlers for internal Spell URLs.
//!
//! Covers artifact://, memory://, skill://, local://, pi://, rule://,
//! agent://, jobs:// and mcp://.

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::Arc,
};

use pi_code_path::resolver::SchemeHandler;

mod artifact;
mod memory;
mod skill;
mod local;
mod pi;
mod rule;
mod agent;
mod jobs;
mod mcp;

pub use artifact::*;
pub use memory::*;
pub use skill::*;
pub use local::*;
pub use pi::*;
pub use rule::*;
pub use agent::*;
pub use jobs::*;
pub use mcp::*;

/// Registry that maps scheme names to their handlers.
#[derive(Default)]
pub struct SchemeRegistry {
	handlers: HashMap<String, Arc<dyn SchemeHandler>>,
}

impl SchemeRegistry {
	/// Create an empty registry.
	pub fn new() -> Self {
		Self::default()
	}

	/// Register a handler, using its `scheme()` as the key.
	pub fn register(&mut self, handler: Arc<dyn SchemeHandler>) {
		self.handlers.insert(handler.scheme().to_string(), handler);
	}

	/// Look up a handler by scheme name.
	pub fn lookup(&self, scheme: &str) -> Option<&Arc<dyn SchemeHandler>> {
		self.handlers.get(scheme)
	}
}

/// Build a registry with all 9 default handlers wired.
pub fn default_registry(
	project_root: PathBuf,
	artifact_root: PathBuf,
	agent_blobs_root: PathBuf,
) -> SchemeRegistry {
	let mut reg = SchemeRegistry::new();
	reg.register(Arc::new(ArtifactHandler { root: artifact_root }));
	reg.register(Arc::new(MemoryHandler {
		project_root: project_root.clone(),
	}));
	reg.register(Arc::new(SkillHandler {
		project_root: project_root.clone(),
	}));
	reg.register(Arc::new(LocalHandler {
		project_root: project_root.clone(),
	}));
	reg.register(Arc::new(PiHandler {
		project_root: project_root.clone(),
	}));
	reg.register(Arc::new(RuleHandler {
		project_root: project_root.clone(),
	}));
	reg.register(Arc::new(AgentHandler {
		agent_blobs_root,
	}));
	reg.register(Arc::new(JobsHandler));
	reg.register(Arc::new(McpHandler));
	reg
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unknown_scheme_returns_none() {
		let reg = default_registry(PathBuf::from("/tmp"), PathBuf::from("/tmp"), PathBuf::from("/tmp"));
		assert!(reg.lookup("no-such-scheme").is_none());
	}

	#[test]
	fn all_nine_schemes_registered() {
		let reg = default_registry(PathBuf::from("/tmp"), PathBuf::from("/tmp"), PathBuf::from("/tmp"));
		for scheme in &["artifact", "memory", "skill", "local", "pi", "rule", "agent", "jobs", "mcp"] {
			assert!(
				reg.lookup(scheme).is_some(),
				"scheme {} should be registered",
				scheme
			);
		}
	}
}
