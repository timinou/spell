//! `LspSemanticBackend` — wraps an [`LspClient`] in the
//! [`crate::semantic::SemanticBackend`] trait.
//!
//! Translates 1-indexed Semantic coordinates to 0-indexed LSP positions
//! at every boundary (per W0g convention). Capability checks gate each
//! call: if the LSP server didn't advertise hover support, we return
//! `InferResult::unknown()` rather than issue a request that would error.

use std::{path::Path, sync::Arc};

use lsp_types::{
	Position, TextDocumentIdentifier, TextDocumentPositionParams,
};

use super::{
	client::{lsp_uri_to_pathbuf, LspClient},
	diagnostics::diagnostics_for_path,
};
use crate::semantic::{
	Capabilities, Confidence, Diagnostic, InferResult, InlayHint, LineRange, Location,
	RenameError, SemanticBackend, SignatureInfo, TextEdit, TypeRepr, TypeSource, WorkspaceEdit,
};

/// `SemanticBackend` impl that routes through one [`LspClient`] instance.
/// Held in an `Arc` for sharing across `CompositeSemanticBackend` slots.
pub struct LspSemanticBackend {
	client:    Arc<LspClient>,
	caps:      Capabilities,
}

impl LspSemanticBackend {
	pub fn new(client: Arc<LspClient>) -> Self {
		let lsp_caps = client.capabilities();
		let caps = derive_capabilities(&lsp_caps);
		Self { client, caps }
	}

	pub fn client(&self) -> &Arc<LspClient> {
		&self.client
	}

	fn doc_position(&self, file: &Path, line: u32, col: u32) -> Option<TextDocumentPositionParams> {
		let uri = lsp_types::Url::from_file_path(file).ok()?;
		Some(TextDocumentPositionParams {
			text_document: TextDocumentIdentifier { uri },
			position:      semantic_to_lsp_position(line, col),
		})
	}
}

impl SemanticBackend for LspSemanticBackend {
	fn capabilities(&self) -> Capabilities {
		self.caps
	}

	fn type_at(&self, file: &Path, line: u32, col: u32) -> InferResult {
		if !self.caps.inferred_hover {
			return InferResult::unknown();
		}
		let Some(params) = self.doc_position(file, line, col) else {
			return InferResult::unknown();
		};
		let hover_params = lsp_types::HoverParams {
			text_document_position_params: params,
			work_done_progress_params:     lsp_types::WorkDoneProgressParams::default(),
		};
		let Ok(Some(hover)) = self.client.request::<lsp_types::request::HoverRequest>(hover_params)
		else {
			return InferResult::unknown();
		};
		let text = hover_contents_to_text(&hover.contents);
		if text.trim().is_empty() {
			return InferResult::unknown();
		}
		InferResult::known(TypeRepr::text(text), Confidence::Inferred, TypeSource::ForwardFlow)
	}

	fn type_definition_of(&self, file: &Path, line: u32, col: u32) -> Option<Location> {
		if !self.caps.type_definition {
			return None;
		}
		let params = self.doc_position(file, line, col)?;
		let goto_params = lsp_types::request::GotoTypeDefinitionParams {
			text_document_position_params: params,
			work_done_progress_params:     lsp_types::WorkDoneProgressParams::default(),
			partial_result_params:         lsp_types::PartialResultParams::default(),
		};
		let response = self
			.client
			.request::<lsp_types::request::GotoTypeDefinition>(goto_params)
			.ok()??;
		first_location_response(response)
	}

	fn signature_at(&self, file: &Path, line: u32, col: u32) -> Option<SignatureInfo> {
		if !self.caps.signature {
			return None;
		}
		let params = self.doc_position(file, line, col)?;
		let sh = lsp_types::SignatureHelpParams {
			context: None,
			text_document_position_params: params,
			work_done_progress_params: lsp_types::WorkDoneProgressParams::default(),
		};
		let help = self
			.client
			.request::<lsp_types::request::SignatureHelpRequest>(sh)
			.ok()??;
		let active = help
			.active_signature
			.and_then(|i| help.signatures.get(i as usize))
			.or_else(|| help.signatures.first())?;
		Some(SignatureInfo {
			signature:     active.label.clone(),
			parameters:    active
				.parameters
				.as_ref()
				.map(|ps| {
					ps.iter()
						.map(|p| match &p.label {
							lsp_types::ParameterLabel::Simple(s) => s.clone(),
							lsp_types::ParameterLabel::LabelOffsets(off) => {
								active.label.get(off[0] as usize..off[1] as usize)
									.unwrap_or("")
									.to_string()
							},
						})
						.collect()
				})
				.unwrap_or_default(),
			active_param:  active.active_parameter.map(|i| i as usize)
				.or(help.active_parameter.map(|i| i as usize)),
			documentation: active.documentation.as_ref().map(documentation_to_text),
		})
	}

	fn inlay_hints(&self, file: &Path, range: Option<LineRange>) -> Vec<InlayHint> {
		if !self.caps.inlay_hints {
			return Vec::new();
		}
		let Ok(uri) = lsp_types::Url::from_file_path(file) else {
			return Vec::new();
		};
		let range = range.map(|r| lsp_types::Range {
			start: Position { line: r.start.saturating_sub(1), character: 0 },
			end:   Position { line: r.end.saturating_sub(1), character: u32::MAX },
		});
		let lsp_range = range.unwrap_or(lsp_types::Range {
			start: Position { line: 0, character: 0 },
			end:   Position { line: u32::MAX, character: 0 },
		});
		let params = lsp_types::InlayHintParams {
			text_document: TextDocumentIdentifier { uri },
			range:         lsp_range,
			work_done_progress_params: lsp_types::WorkDoneProgressParams::default(),
		};
		let Ok(Some(hints)) =
			self.client.request::<lsp_types::request::InlayHintRequest>(params)
		else {
			return Vec::new();
		};
		hints
			.into_iter()
			.map(|h| InlayHint {
				location: Location {
					file: file.to_path_buf(),
					line: h.position.line + 1,
					col:  h.position.character + 1,
					end:  None,
				},
				label: match h.label {
					lsp_types::InlayHintLabel::String(s) => s,
					lsp_types::InlayHintLabel::LabelParts(parts) => parts
						.iter()
						.map(|p| p.value.clone())
						.collect::<Vec<_>>()
						.join(""),
				},
				kind: match h.kind {
					Some(lsp_types::InlayHintKind::TYPE) => crate::semantic::InlayKind::Type,
					Some(lsp_types::InlayHintKind::PARAMETER) => crate::semantic::InlayKind::Parameter,
					_ => crate::semantic::InlayKind::Type,
				},
			})
			.collect()
	}

	fn diagnostics(&self, file: &Path) -> Vec<Diagnostic> {
		diagnostics_for_path(&self.client, file)
	}

	fn rename_preview(
		&self,
		file: &Path,
		line: u32,
		col: u32,
		new_name: &str,
	) -> Result<WorkspaceEdit, RenameError> {
		if !self.caps.rename {
			return Err(RenameError::Unsupported);
		}
		let Some(params) = self.doc_position(file, line, col) else {
			return Err(RenameError::NoSymbol);
		};
		let rename = lsp_types::RenameParams {
			text_document_position: params,
			new_name: new_name.into(),
			work_done_progress_params: lsp_types::WorkDoneProgressParams::default(),
		};
		let edit = self
			.client
			.request::<lsp_types::request::Rename>(rename)
			.map_err(|e| RenameError::BackendError(e.to_string()))?
			.ok_or(RenameError::NoSymbol)?;
		Ok(convert_workspace_edit(edit))
	}
}

fn semantic_to_lsp_position(line: u32, col: u32) -> Position {
	Position { line: line.saturating_sub(1), character: col.saturating_sub(1) }
}

fn hover_contents_to_text(contents: &lsp_types::HoverContents) -> String {
	match contents {
		lsp_types::HoverContents::Scalar(s) => marked_string_to_text(s),
		lsp_types::HoverContents::Array(arr) => arr
			.iter()
			.map(marked_string_to_text)
			.collect::<Vec<_>>()
			.join("\n"),
		lsp_types::HoverContents::Markup(m) => m.value.clone(),
	}
}

fn marked_string_to_text(s: &lsp_types::MarkedString) -> String {
	match s {
		lsp_types::MarkedString::String(s) => s.clone(),
		lsp_types::MarkedString::LanguageString(ls) => ls.value.clone(),
	}
}

fn documentation_to_text(d: &lsp_types::Documentation) -> String {
	match d {
		lsp_types::Documentation::String(s) => s.clone(),
		lsp_types::Documentation::MarkupContent(m) => m.value.clone(),
	}
}

fn first_location_response(resp: lsp_types::GotoDefinitionResponse) -> Option<Location> {
	let lsp_loc = match resp {
		lsp_types::GotoDefinitionResponse::Scalar(loc) => loc,
		lsp_types::GotoDefinitionResponse::Array(arr) => arr.into_iter().next()?,
		lsp_types::GotoDefinitionResponse::Link(arr) => {
			let link = arr.into_iter().next()?;
			lsp_types::Location {
				uri: link.target_uri,
				range: link.target_selection_range,
			}
		},
	};
	Some(Location {
		file: lsp_uri_to_pathbuf(&lsp_loc.uri),
		line: lsp_loc.range.start.line + 1,
		col:  lsp_loc.range.start.character + 1,
		end:  Some((lsp_loc.range.end.line + 1, lsp_loc.range.end.character + 1)),
	})
}

fn convert_workspace_edit(edit: lsp_types::WorkspaceEdit) -> WorkspaceEdit {
	let mut edits = Vec::new();
	if let Some(changes) = edit.changes {
		for (uri, text_edits) in changes {
			for te in text_edits {
				edits.push(TextEdit {
					location: Location {
						file: lsp_uri_to_pathbuf(&uri),
						line: te.range.start.line + 1,
						col:  te.range.start.character + 1,
						end:  Some((te.range.end.line + 1, te.range.end.character + 1)),
					},
					new_text: te.new_text,
				});
			}
		}
	}
	WorkspaceEdit { edits }
}

fn derive_capabilities(lsp_caps: &lsp_types::ServerCapabilities) -> Capabilities {
	let has_hover = lsp_caps.hover_provider.is_some();
	let has_type_def = lsp_caps.type_definition_provider.is_some();
	let has_signature = lsp_caps.signature_help_provider.is_some();
	let has_inlay = lsp_caps.inlay_hint_provider.is_some();
	let has_diag = lsp_caps.diagnostic_provider.is_some()
		|| lsp_caps.text_document_sync.is_some(); // many servers push diagnostics on sync
	let has_rename = match &lsp_caps.rename_provider {
		Some(lsp_types::OneOf::Left(true)) => true,
		Some(lsp_types::OneOf::Right(_)) => true,
		_ => false,
	};
	let has_refs = lsp_caps.references_provider.is_some();
	Capabilities {
		inferred_hover:      has_hover,
		type_definition:     has_type_def,
		signature:           has_signature,
		inlay_hints:         has_inlay,
		narrow_dispatch:     has_refs, // refs is the building block for narrowing
		diagnostics:         has_diag,
		rename:              has_rename,
		references_narrowed: has_refs,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn semantic_to_lsp_position_zero_indexes() {
		assert_eq!(semantic_to_lsp_position(1, 1), Position { line: 0, character: 0 });
		assert_eq!(semantic_to_lsp_position(10, 5), Position { line: 9, character: 4 });
		// Saturating: 0 input stays 0 (defensive against bad caller).
		assert_eq!(semantic_to_lsp_position(0, 0), Position { line: 0, character: 0 });
	}

	#[test]
	fn derive_capabilities_reflects_server_advertisement() {
		let mut lsp = lsp_types::ServerCapabilities::default();
		let caps = derive_capabilities(&lsp);
		assert!(!caps.inferred_hover);
		assert!(!caps.rename);

		lsp.hover_provider = Some(lsp_types::HoverProviderCapability::Simple(true));
		lsp.rename_provider = Some(lsp_types::OneOf::Left(true));
		let caps = derive_capabilities(&lsp);
		assert!(caps.inferred_hover);
		assert!(caps.rename);
	}

	#[test]
	fn hover_contents_to_text_handles_all_variants() {
		let scalar = lsp_types::HoverContents::Scalar(lsp_types::MarkedString::String("foo".into()));
		assert_eq!(hover_contents_to_text(&scalar), "foo");

		let lang = lsp_types::HoverContents::Scalar(lsp_types::MarkedString::LanguageString(
			lsp_types::LanguageString { language: "rust".into(), value: "fn x()".into() },
		));
		assert_eq!(hover_contents_to_text(&lang), "fn x()");

		let arr = lsp_types::HoverContents::Array(vec![
			lsp_types::MarkedString::String("a".into()),
			lsp_types::MarkedString::String("b".into()),
		]);
		assert_eq!(hover_contents_to_text(&arr), "a\nb");

		let markup = lsp_types::HoverContents::Markup(lsp_types::MarkupContent {
			kind:  lsp_types::MarkupKind::Markdown,
			value: "# heading".into(),
		});
		assert_eq!(hover_contents_to_text(&markup), "# heading");
	}

	#[test]
	fn first_location_response_handles_all_variants() {
		let uri = lsp_types::Url::parse("file:///tmp/foo.rs").unwrap();
		let range = lsp_types::Range {
			start: Position { line: 5, character: 2 },
			end:   Position { line: 5, character: 10 },
		};
		// Scalar
		let scalar = lsp_types::GotoDefinitionResponse::Scalar(lsp_types::Location {
			uri: uri.clone(),
			range,
		});
		let loc = first_location_response(scalar).unwrap();
		assert_eq!(loc.line, 6, "LSP 0->1 indexing");
		assert_eq!(loc.col, 3);
		assert_eq!(loc.end, Some((6, 11)));

		// Array
		let arr = lsp_types::GotoDefinitionResponse::Array(vec![lsp_types::Location {
			uri,
			range,
		}]);
		assert!(first_location_response(arr).is_some());
	}

	#[test]
	fn convert_workspace_edit_emits_per_text_edit_location() {
		let uri = lsp_types::Url::parse("file:///tmp/foo.rs").unwrap();
		let mut changes = std::collections::HashMap::new();
		changes.insert(
			uri,
			vec![lsp_types::TextEdit {
				range:    lsp_types::Range::default(),
				new_text: "new".into(),
			}],
		);
		let we = lsp_types::WorkspaceEdit { changes: Some(changes), document_changes: None, change_annotations: None };
		let out = convert_workspace_edit(we);
		assert_eq!(out.edits.len(), 1);
		assert_eq!(out.edits[0].new_text, "new");
	}
}
