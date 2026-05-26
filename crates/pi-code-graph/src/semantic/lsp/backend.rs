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
	client:      Arc<LspClient>,
	caps:        Capabilities,
	/// FUP-100: the LSP `languageId` for didOpen, sourced from KDL
	/// `language "<id>" { lsp "<server>" }` config. Falls back to
	/// `"plaintext"` when constructed via the legacy ctor.
	language_id: String,
}

impl LspSemanticBackend {
	/// Legacy ctor — retained for tests that don't care about didOpen.
	/// Uses `"plaintext"` as the language ID; the LSP may reject hover
	/// requests for documents it considers untyped.
	pub fn new(client: Arc<LspClient>) -> Self {
		Self::with_language_id(client, "plaintext")
	}

	/// Construct with an explicit LSP `languageId`. Production callers go
	/// via this path; the KDL config's `language` field is the source.
	pub fn with_language_id(client: Arc<LspClient>, language_id: impl Into<String>) -> Self {
		let lsp_caps = client.capabilities();
		let caps = derive_capabilities(&lsp_caps);
		Self { client, caps, language_id: language_id.into() }
	}

	pub fn client(&self) -> &Arc<LspClient> {
		&self.client
	}

	pub fn language_id(&self) -> &str {
		&self.language_id
	}

	fn doc_position(&self, file: &Path, line: u32, col: u32) -> Option<TextDocumentPositionParams> {
		let uri = lsp_types::Url::from_file_path(file).ok()?;
		Some(TextDocumentPositionParams {
			text_document: TextDocumentIdentifier { uri },
			position:      semantic_to_lsp_position(line, col),
		})
	}

	/// FUP-100: ensure the LSP has been told about `file` via
	/// `textDocument/didOpen`. Reads file contents from disk on first
	/// open; subsequent calls no-op (DocumentSync is idempotent). Buffer
	/// edits update the LSP via `notify_buffer_change` from
	/// `semantic_cache`, not via this method.
	fn ensure_synced(&self, file: &Path) {
		if self.client.is_open(file) {
			return;
		}
		// Read from disk so the LSP at least sees the persisted text.
		// Dirty-buffer state lands later via the code_buffer →
		// notify_buffer_change channel.
		let text = std::fs::read_to_string(file).unwrap_or_default();
		self.client.ensure_opened(file, &self.language_id, &text);
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
		self.ensure_synced(file);
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
		self.ensure_synced(file);
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
		self.ensure_synced(file);
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
		self.ensure_synced(file);
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
		self.ensure_synced(file);
		diagnostics_for_path(&self.client, file)
	}

	/// W1g (P1): implement references_narrowed via LSP textDocument/references.
	///
	/// `receiver_filter` is currently a stub: when `None`, returns the full
	/// LSP reference list (this is the common case). When `Some`, returns an
	/// empty Vec — honest fallback until type-aware filter is wired in a
	/// future iteration. The capability bit advertises that the backend can
	/// answer the question, not that it implements the filter.
	fn references_narrowed(
		&self,
		symbol: &Location,
		receiver_filter: Option<&TypeRepr>,
	) -> Vec<Location> {
		if !self.caps.references_narrowed {
			return Vec::new();
		}
		if receiver_filter.is_some() {
			return Vec::new();
		}
		let Ok(uri) = lsp_types::Url::from_file_path(&symbol.file) else {
			return Vec::new();
		};
		let params = lsp_types::ReferenceParams {
			text_document_position: TextDocumentPositionParams {
				text_document: TextDocumentIdentifier { uri },
				position: semantic_to_lsp_position(symbol.line, symbol.col),
			},
			work_done_progress_params: lsp_types::WorkDoneProgressParams::default(),
			partial_result_params: lsp_types::PartialResultParams::default(),
			context: lsp_types::ReferenceContext { include_declaration: false },
		};
		let Ok(Some(refs)) = self.client.request::<lsp_types::request::References>(params) else {
			return Vec::new();
		};
		refs.into_iter()
			.map(|loc| Location {
				file: lsp_uri_to_pathbuf(&loc.uri),
				line: loc.range.start.line + 1,
				col:  loc.range.start.character + 1,
				end:  Some((loc.range.end.line + 1, loc.range.end.character + 1)),
			})
			.collect()
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

/// W1g (P1) fix: handle BOTH `changes` (legacy LSP format) AND
/// `document_changes` (newer format used by rust-analyzer, vtsls, gopls).
/// Without this, modern servers silently produce empty rename edits.
fn convert_workspace_edit(edit: lsp_types::WorkspaceEdit) -> WorkspaceEdit {
	let mut edits = Vec::new();

	// Legacy `changes: HashMap<Uri, Vec<TextEdit>>`.
	if let Some(changes) = edit.changes {
		for (uri, text_edits) in changes {
			let file = lsp_uri_to_pathbuf(&uri);
			for te in text_edits {
				edits.push(text_edit_to_semantic(&file, te));
			}
		}
	}

	// Newer `document_changes` — either Edits or Operations.
	if let Some(doc_changes) = edit.document_changes {
		match doc_changes {
			lsp_types::DocumentChanges::Edits(text_doc_edits) => {
				for tde in text_doc_edits {
					let file = lsp_uri_to_pathbuf(&tde.text_document.uri);
					for edit_op in tde.edits {
						if let Some(te) = annotated_text_edit_to_text_edit(edit_op) {
							edits.push(text_edit_to_semantic(&file, te));
						}
					}
				}
			},
			lsp_types::DocumentChanges::Operations(ops) => {
				for op in ops {
					// Only TextDocumentEdit variants are renames-as-edits.
					// CreateFile / RenameFile / DeleteFile are out of scope here;
					// rename_preview shouldn't be producing them.
					if let lsp_types::DocumentChangeOperation::Edit(tde) = op {
						let file = lsp_uri_to_pathbuf(&tde.text_document.uri);
						for edit_op in tde.edits {
							if let Some(te) = annotated_text_edit_to_text_edit(edit_op) {
								edits.push(text_edit_to_semantic(&file, te));
							}
						}
					}
				}
			},
		}
	}

	WorkspaceEdit { edits }
}

fn text_edit_to_semantic(file: &Path, te: lsp_types::TextEdit) -> TextEdit {
	TextEdit {
		location: Location {
			file: file.to_path_buf(),
			line: te.range.start.line + 1,
			col:  te.range.start.character + 1,
			end:  Some((te.range.end.line + 1, te.range.end.character + 1)),
		},
		new_text: te.new_text,
	}
}

fn annotated_text_edit_to_text_edit(
	edit: lsp_types::OneOf<lsp_types::TextEdit, lsp_types::AnnotatedTextEdit>,
) -> Option<lsp_types::TextEdit> {
	match edit {
		lsp_types::OneOf::Left(te) => Some(te),
		lsp_types::OneOf::Right(ate) => Some(ate.text_edit),
	}
}

fn derive_capabilities(lsp_caps: &lsp_types::ServerCapabilities) -> Capabilities {
	let has_hover = lsp_caps.hover_provider.is_some();
	let has_type_def = lsp_caps.type_definition_provider.is_some();
	let has_signature = lsp_caps.signature_help_provider.is_some();
	let has_inlay = lsp_caps.inlay_hint_provider.is_some();
	// W1g (P2): diagnostic capability requires the explicit diagnostic_provider
	// advertisement. textDocument/sync was a false-positive proxy (many servers
	// advertise sync but don't push diagnostics).
	let has_diag = lsp_caps.diagnostic_provider.is_some();
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
		// W1g (P1): LspSemanticBackend uses the default trait impl for
		// narrow_dispatch (returns candidates unchanged — no real narrowing).
		// Setting this `true` would be lying about capability; leave `false`
		// until a future iteration implements actual type-based narrowing.
		narrow_dispatch:     false,
		diagnostics:         has_diag,
		rename:              has_rename,
		// References-narrowed is implemented below: returns full LSP refs when
		// `receiver_filter` is None, empty when Some (filter is a stub). Cap
		// is honest about "has any answer" — the filter case is documented.
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

	/// W1g (P1 regression): the newer `document_changes: Edits` format used by
	/// rust-analyzer / vtsls must produce the same TextEdit output as the
	/// legacy `changes` map.
	#[test]
	fn convert_workspace_edit_handles_document_changes_edits_variant() {
		let uri = lsp_types::Url::parse("file:///tmp/foo.rs").unwrap();
		let tde = lsp_types::TextDocumentEdit {
			text_document: lsp_types::OptionalVersionedTextDocumentIdentifier {
				uri:     uri.clone(),
				version: Some(1),
			},
			edits: vec![lsp_types::OneOf::Left(lsp_types::TextEdit {
				range:    lsp_types::Range {
					start: lsp_types::Position { line: 4, character: 2 },
					end:   lsp_types::Position { line: 4, character: 7 },
				},
				new_text: "renamed".into(),
			})],
		};
		let we = lsp_types::WorkspaceEdit {
			changes:            None,
			document_changes:   Some(lsp_types::DocumentChanges::Edits(vec![tde])),
			change_annotations: None,
		};
		let out = convert_workspace_edit(we);
		assert_eq!(out.edits.len(), 1, "document_changes::Edits must emit edits");
		let e = &out.edits[0];
		assert_eq!(e.new_text, "renamed");
		assert_eq!(e.location.line, 5);
		assert_eq!(e.location.col, 3);
		assert_eq!(e.location.end, Some((5, 8)));
	}

	/// W1g (P1 regression): `document_changes: Operations` with an Edit variant
	/// emits TextEdits; other operations (Create/Rename/Delete) are skipped.
	#[test]
	fn convert_workspace_edit_handles_document_changes_operations_variant() {
		let uri = lsp_types::Url::parse("file:///tmp/foo.rs").unwrap();
		let tde = lsp_types::TextDocumentEdit {
			text_document: lsp_types::OptionalVersionedTextDocumentIdentifier {
				uri:     uri.clone(),
				version: None,
			},
			edits: vec![lsp_types::OneOf::Left(lsp_types::TextEdit {
				range:    lsp_types::Range::default(),
				new_text: "from-ops".into(),
			})],
		};
		let ops = vec![
			lsp_types::DocumentChangeOperation::Edit(tde),
			lsp_types::DocumentChangeOperation::Op(lsp_types::ResourceOp::Delete(
				lsp_types::DeleteFile { uri, options: None },
			)),
		];
		let we = lsp_types::WorkspaceEdit {
			changes:            None,
			document_changes:   Some(lsp_types::DocumentChanges::Operations(ops)),
			change_annotations: None,
		};
		let out = convert_workspace_edit(we);
		assert_eq!(
			out.edits.len(),
			1,
			"only the Edit variant emits a TextEdit; Delete is skipped"
		);
		assert_eq!(out.edits[0].new_text, "from-ops");
	}

	/// W1g (P1 regression): derive_capabilities must not lie about capabilities
	/// the backend doesn't implement.
	#[test]
	fn derive_capabilities_does_not_claim_unimplemented_features() {
		let mut lsp = lsp_types::ServerCapabilities::default();
		lsp.references_provider = Some(lsp_types::OneOf::Left(true));
		let caps = derive_capabilities(&lsp);
		assert!(
			!caps.narrow_dispatch,
			"narrow_dispatch is the default trait impl (pass-through); cap must be false"
		);
		assert!(
			caps.references_narrowed,
			"references_narrowed IS implemented (LSP textDocument/references)"
		);
	}

	/// W1g (P2 regression): diagnostics cap requires explicit
	/// diagnostic_provider, not the looser "sync implies diagnostics" proxy.
	#[test]
	fn derive_capabilities_diagnostics_requires_explicit_provider() {
		let mut lsp = lsp_types::ServerCapabilities::default();
		lsp.text_document_sync = Some(lsp_types::TextDocumentSyncCapability::Kind(
			lsp_types::TextDocumentSyncKind::FULL,
		));
		let caps = derive_capabilities(&lsp);
		assert!(
			!caps.diagnostics,
			"sync alone is not a diagnostics advertisement"
		);

		lsp.diagnostic_provider = Some(lsp_types::DiagnosticServerCapabilities::Options(
			lsp_types::DiagnosticOptions::default(),
		));
		let caps = derive_capabilities(&lsp);
		assert!(caps.diagnostics, "explicit diagnostic_provider unlocks the cap");
	}
}
