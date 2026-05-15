//! NAPI exports for kernel introspection.
//!
//! Bridges `pi_code_path::introspection` functions to the JS side.
//! `list_language_dialects` is implemented here because `pi-code-path`
//! cannot depend on `pi-code-engine` (upward dependency).

use napi_derive::napi;

// ── NAPI DTOs ────────────────────────────────────────────────────

#[napi(object)]
pub struct OpKindInfo {
	pub kind:            String,
	pub family:          String,
	pub target_shape:    String,
	pub required_fields: Vec<String>,
	pub optional_fields: Vec<String>,
}

#[napi(object)]
pub struct QualifierInfo {
	pub name:        String,
	pub args_schema: Option<String>,
	pub applies_to:  Vec<String>,
}

#[napi(object)]
pub struct EdgeKindInfo {
	pub symbol:      String,
	pub name:        String,
	pub description: String,
}

#[napi(object)]
pub struct DiagnosticVariantInfo {
	pub variant:  String,
	pub severity: String,
	pub template: String,
}

#[napi(object)]
pub struct LanguageDialectInfo {
	pub id:           String,
	pub extensions:   Vec<String>,
	pub capabilities: Vec<String>,
}

// ── Helpers ──────────────────────────────────────────────────────

impl From<pi_code_path::introspection::OpKindInfo> for OpKindInfo {
	fn from(info: pi_code_path::introspection::OpKindInfo) -> Self {
		OpKindInfo {
			kind:            info.kind,
			family:          info.family,
			target_shape:    info.target_shape,
			required_fields: info.required_fields,
			optional_fields: info.optional_fields,
		}
	}
}

impl From<pi_code_path::introspection::QualifierInfo> for QualifierInfo {
	fn from(info: pi_code_path::introspection::QualifierInfo) -> Self {
		QualifierInfo {
			name:        info.name,
			args_schema: info.args_schema,
			applies_to:  info.applies_to,
		}
	}
}

impl From<pi_code_path::introspection::EdgeKindInfo> for EdgeKindInfo {
	fn from(info: pi_code_path::introspection::EdgeKindInfo) -> Self {
		EdgeKindInfo {
			symbol:      info.symbol,
			name:        info.name,
			description: info.description,
		}
	}
}

impl From<pi_code_path::introspection::DiagnosticVariantInfo> for DiagnosticVariantInfo {
	fn from(info: pi_code_path::introspection::DiagnosticVariantInfo) -> Self {
		DiagnosticVariantInfo {
			variant:  info.variant,
			severity: info.severity,
			template: info.template,
		}
	}
}

/// Build a list of capabilities from a `LanguageCapabilities` struct.
fn capabilities_from(caps: &pi_code_engine::language::LanguageCapabilities) -> Vec<String> {
	let mut result = Vec::new();
	if caps.outline {
		result.push("outline".to_string());
	}
	if caps.outline_enrichment {
		result.push("outline_enrichment".to_string());
	}
	if caps.read {
		result.push("read".to_string());
	}
	if caps.navigate {
		result.push("navigate".to_string());
	}
	if caps.resolve {
		result.push("resolve".to_string());
	}
	if caps.edit {
		result.push("edit".to_string());
	}
	if caps.graph {
		result.push("graph".to_string());
	}
	for lang in &caps.embedded_languages {
		result.push(format!("embed:{}", lang));
	}
	result
}

// ── Exports ──────────────────────────────────────────────────────

/// List all Op kind variants with family, target shape, and field metadata.
#[napi]
pub fn list_op_kinds() -> Vec<OpKindInfo> {
	pi_code_path::introspection::list_op_kinds()
		.into_iter()
		.map(OpKindInfo::from)
		.collect()
}

/// List all registered qualifiers across FS and text dialects.
#[napi]
pub fn list_qualifiers() -> Vec<QualifierInfo> {
	pi_code_path::introspection::list_qualifiers()
		.into_iter()
		.map(QualifierInfo::from)
		.collect()
}

/// List all CodePath graph edge kinds.
#[napi]
pub fn list_edge_kinds() -> Vec<EdgeKindInfo> {
	pi_code_path::introspection::list_edge_kinds()
		.into_iter()
		.map(EdgeKindInfo::from)
		.collect()
}

/// List all diagnostic variant types with severity and message templates.
#[napi]
pub fn list_diagnostic_variants() -> Vec<DiagnosticVariantInfo> {
	pi_code_path::introspection::list_diagnostic_variants()
		.into_iter()
		.map(DiagnosticVariantInfo::from)
		.collect()
}

/// List all registered language dialects with extensions and capabilities.
///
/// Uses `pi_code_engine::LanguageRegistry::with_builtins()` so this
/// function lives in the NAPI layer rather than `pi-code-path`.
#[napi]
pub fn list_language_dialects() -> Vec<LanguageDialectInfo> {
	let reg = match pi_code_engine::language::LanguageRegistry::with_builtins() {
		Ok(r) => r,
		Err(_e) => {
			// If the registry fails, return empty — the NAPI bridge should not panic.
			// NOTE: `tracing` crate not directly available in pi-natives.
			return Vec::new();
		},
	};

	let mut dialects = Vec::new();
	for id in reg.languages() {
		if let Some(profile) = reg.get(id) {
			dialects.push(LanguageDialectInfo {
				id:           id.to_string(),
				extensions:   profile.extensions.clone(),
				capabilities: capabilities_from(&profile.capabilities),
			});
		}
	}
	dialects
}
