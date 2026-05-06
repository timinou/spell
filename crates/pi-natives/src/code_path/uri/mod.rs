//! URI scheme registry and handlers for internal Spell URLs.
//!
//! All schemes are owned by the JS InternalUrlRouter (FEAT-721).
//! The Rust kernel registry is kept empty; URI locators that reach the
//! kernel are by construction unknown schemes.

use std::{collections::HashMap, sync::Arc};

use pi_code_path::resolver::SchemeHandler;

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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unknown_scheme_returns_none() {
		let reg = SchemeRegistry::new();
		assert!(reg.lookup("no-such-scheme").is_none());
	}
}
