mod elixir;
mod typescript;

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
	sync::Arc,
};

pub use elixir::{ElixirExtractor, ElixirImportResolver};
use serde::{Deserialize, Serialize};
pub use typescript::{TypeScriptExtractor, TypeScriptImportResolver};

use crate::{
	error::{CodeGraphError, Result},
	model::SymbolKind,
};

use pi_code_engine::language::LanguageRegistry as EngineRegistry;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SupportedLanguage(pub String);

impl SupportedLanguage {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}

	pub fn engine_profile<'a>(&self, registry: &'a EngineRegistry) -> Option<&'a pi_code_engine::language::LanguageProfile> {
		registry.get(&pi_code_engine::language::LanguageId::new(self.as_str()))
	}
}

#[derive(Debug, Clone)]
pub struct ExtractedFile {
	pub path:     PathBuf,
	pub language: SupportedLanguage,
	pub symbols:  Vec<ExtractedSymbol>,
	pub imports:  Vec<ExtractedImport>,
}

#[derive(Debug, Clone)]
pub struct ExtractedSymbol {
	pub name:           String,
	pub qualified_name: String,
	pub kind:           SymbolKind,
	pub exported:       bool,
	pub line:           u32,
	pub column:         u32,
	pub detail:         Option<String>,
	pub references:     Vec<ExtractedReference>,
}

#[derive(Debug, Clone)]
pub struct ExtractedReference {
	pub target_name: String,
	pub edge_kind:   crate::model::EdgeKind,
}

#[derive(Debug, Clone)]
pub struct ExtractedImportBinding {
	pub imported_name: String,
	pub local_name:    String,
}

#[derive(Debug, Clone)]
pub struct ExtractedImport {
	pub specifier:    String,
	pub bindings:     Vec<ExtractedImportBinding>,
	pub is_type_only: bool,
}

#[derive(Debug, Clone)]
pub struct ResolveRequest<'a> {
	pub project_root: &'a Path,
	pub from_file:    &'a Path,
	pub specifier:    &'a str,
}

pub trait LanguageExtractor: Send + Sync {
	fn language(&self) -> SupportedLanguage;

	fn matches_path(&self, path: &Path) -> bool;

	fn extract(&self, path: &Path, source: &str) -> Result<ExtractedFile>;
}

pub trait ImportResolver: Send + Sync {
	fn language(&self) -> SupportedLanguage;

	fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>>;
}

#[derive(Clone)]
pub struct RegisteredLanguage {
	pub extractor: Arc<dyn LanguageExtractor>,
	pub resolver:  Arc<dyn ImportResolver>,
}

#[derive(Clone, Default)]
pub struct LanguageRegistry {
	by_name: BTreeMap<SupportedLanguage, RegisteredLanguage>,
}

impl LanguageRegistry {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn with_typescript(mut self) -> Result<Self> {
		self.register(Arc::new(TypeScriptExtractor), Arc::new(TypeScriptImportResolver))?;
		Ok(self)
	}

	pub fn with_elixir(mut self) -> Result<Self> {
		self.register(Arc::new(ElixirExtractor), Arc::new(ElixirImportResolver))?;
		Ok(self)
	}

	pub fn with_defaults(self) -> Result<Self> {
		self.with_typescript()?.with_elixir()
	}

	pub fn register(
		&mut self,
		extractor: Arc<dyn LanguageExtractor>,
		resolver: Arc<dyn ImportResolver>,
	) -> Result<()> {
		let extractor_language = extractor.language();
		let resolver_language = resolver.language();
		if extractor_language != resolver_language {
			return Err(CodeGraphError::MissingLanguage(format!(
				"mismatched extractor/resolver registration: {} vs {}",
				extractor_language.as_str(),
				resolver_language.as_str()
			)));
		}
		if self.by_name.contains_key(&extractor_language) {
			return Err(CodeGraphError::DuplicateLanguage(extractor_language.0));
		}
		self
			.by_name
			.insert(extractor_language, RegisteredLanguage { extractor, resolver });
		Ok(())
	}

	pub fn supported_languages(&self) -> Vec<SupportedLanguage> {
		self.by_name.keys().cloned().collect()
	}

	pub fn match_path(&self, path: &Path) -> Option<RegisteredLanguage> {
		self
			.by_name
			.values()
			.find(|registered| registered.extractor.matches_path(path))
			.cloned()
	}

	pub fn by_language(&self, language: &SupportedLanguage) -> Option<&RegisteredLanguage> {
		self.by_name.get(language)
	}
}

/// Get engine's language registry with built-in profiles.
/// This provides access to declaration patterns, production rules,
/// and tree-sitter languages for all supported languages.
pub fn engine_registry() -> Result<EngineRegistry> {
	EngineRegistry::with_builtins()
		.map_err(|e| crate::error::CodeGraphError::MissingLanguage(e.to_string()))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;

	#[derive(Clone)]
	struct FakeExtractor;

	impl LanguageExtractor for FakeExtractor {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("fake")
		}

		fn matches_path(&self, path: &Path) -> bool {
			path.extension().and_then(|extension| extension.to_str()) == Some("fake")
		}

		fn extract(&self, path: &Path, _source: &str) -> Result<ExtractedFile> {
			Ok(ExtractedFile {
				path:     path.to_path_buf(),
				language: self.language(),
				symbols:  Vec::new(),
				imports:  Vec::new(),
			})
		}
	}

	#[derive(Clone)]
	struct FakeResolver;

	impl ImportResolver for FakeResolver {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("fake")
		}

		fn resolve(&self, _request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
			Ok(None)
		}
	}

	#[test]
	fn registry_rejects_duplicate_language() {
		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("initial registration should succeed");
		let err = registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect_err("duplicate registration should fail");
		assert!(matches!(err, CodeGraphError::DuplicateLanguage(_)));
	}

	#[test]
	fn registry_matches_supported_path() {
		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("initial registration should succeed");
		assert!(registry.match_path(Path::new("file.fake")).is_some());
		assert!(registry.match_path(Path::new("file.rs")).is_none());
	}
}
