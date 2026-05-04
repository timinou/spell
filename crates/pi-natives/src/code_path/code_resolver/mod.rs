pub mod predicates;
pub mod walker;

#[cfg(test)]
mod go_qualifier_tests;
#[cfg(test)]
mod py_qualifier_tests;
#[cfg(test)]
mod qualifier_tests;
use std::sync::Arc;

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::types::{Diagnostic, DiagnosticVariant};
pub use walker::CodeResolverImpl;

/// Convenience constructor using the built-in language registry.
pub fn new() -> Result<CodeResolverImpl, Diagnostic> {
	let registry = LanguageRegistry::with_builtins().map_err(|e| Diagnostic {
		variant: DiagnosticVariant::UnsupportedOperation,
		message: format!("failed to initialise language registry: {e}"),
		span:    None,
	})?;
	Ok(CodeResolverImpl::new(Arc::new(registry)))
}
