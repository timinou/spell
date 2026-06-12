//! Read-lane entry points (P3.1).
//!
//! Thin sugar over [`CodeResolverImpl`] so a host skin (NAPI today, rustler
//! next) can resolve a read query without re-implementing the walker's result
//! assembly. The error is the resolver's native [`Diagnostic`]; each skin maps
//! it to its own boundary error.

use std::{path::Path, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Qualifier, Query},
	resolver::{CancellationToken, CodeResolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

use crate::walker::CodeResolverImpl;

/// Construct a [`CodeResolverImpl`] backed by the built-in language registry.
///
/// This is the host-agnostic replacement for the old
/// `pi-natives::code_resolver::new()` — note it returns the bare kernel
/// resolver, NOT pi-natives' `NativeResolver` write-wrapper.
pub fn new() -> Result<CodeResolverImpl, Diagnostic> {
	let registry = LanguageRegistry::with_builtins().map_err(|e| Diagnostic {
		variant: DiagnosticVariant::UnsupportedOperation,
		message: format!("failed to initialise language registry: {e}"),
		span:    None,
	})?;
	Ok(CodeResolverImpl::new(Arc::new(registry)))
}

/// Resolve a read query against a single file with a shared registry.
///
/// The host-agnostic read primitive both skins call. `registry` is shared
/// (cloned `Arc`) so a warm kernel builds the language registry once.
pub fn resolve_read(
	registry: &Arc<LanguageRegistry>,
	file: &Path,
	query: &Query,
	qualifier: Option<&Qualifier>,
	cancel: &CancellationToken,
) -> Result<Vec<NodeRef>, Diagnostic> {
	CodeResolverImpl::new(registry.clone()).resolve(file, query, qualifier, cancel)
}
