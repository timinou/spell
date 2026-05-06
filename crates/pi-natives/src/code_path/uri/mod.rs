//! URI scheme registry and handlers for internal Spell URLs.
//!
//! artifact:// remains in Rust; all other schemes are owned by the JS
//! InternalUrlRouter (FEAT-721).

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use pi_code_path::resolver::SchemeHandler;

mod artifact;

pub use artifact::*;

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

/// Build a registry with only the artifact handler wired.
pub fn default_registry(artifact_root: PathBuf) -> SchemeRegistry {
	let mut reg = SchemeRegistry::new();
	reg.register(Arc::new(ArtifactHandler { root: artifact_root }));
	reg
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unknown_scheme_returns_none() {
		let reg = default_registry(PathBuf::from("/tmp"));
		assert!(reg.lookup("no-such-scheme").is_none());
	}

	#[test]
	fn only_artifact_scheme_registered() {
		let reg = default_registry(PathBuf::from("/tmp"));
		assert!(reg.lookup("artifact").is_some(), "scheme artifact should be registered");
	}
}
