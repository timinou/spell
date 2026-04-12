#![allow(
	clippy::derive_partial_eq_without_eq,
	clippy::missing_const_for_fn,
	reason = "surface state models favor serde ergonomics over const/eq style lints"
)]

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::renderer::{RenderedDocument, render_document};

const PAGE_WIDTH: f32 = 816.0;
const PAGE_HEIGHT: f32 = 1_056.0;
const PAGE_GAP: f32 = 32.0;
const PAGE_MARGIN_X: f32 = 72.0;
const PAGE_MARGIN_Y: f32 = 64.0;
const DEFAULT_VIEWPORT_WIDTH: f32 = 960.0;
const DEFAULT_VIEWPORT_HEIGHT: f32 = 720.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendCapability {
	Interactive,
	Mixed,
	PreviewOnly,
	RecoveryOnly,
	Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedReason {
	ForcedFallback,
	UnsupportedSyntax,
	SyntaxError,
	UnsupportedBlock,
	RendererUnavailable,
	StaleMapping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
	Heading,
	Paragraph,
	ListItem,
	Image,
	Table,
	Variable,
	Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportState {
	pub width:    f32,
	pub height:   f32,
	pub zoom:     f32,
	pub scroll_x: f32,
	pub scroll_y: f32,
}

impl Default for ViewportState {
	fn default() -> Self {
		Self {
			width:    DEFAULT_VIEWPORT_WIDTH,
			height:   DEFAULT_VIEWPORT_HEIGHT,
			zoom:     1.0,
			scroll_x: 0.0,
			scroll_y: 0.0,
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
	pub anchor:       String,
	pub start_line:   u32,
	pub end_line:     u32,
	pub start_column: u32,
	pub end_column:   u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBounds {
	pub page:   u32,
	pub x:      f32,
	pub y:      f32,
	pub width:  f32,
	pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMetric {
	pub page:   u32,
	pub width:  f32,
	pub height: f32,
	pub blocks: u32,
	pub ready:  bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDiagnostic {
	pub code:    String,
	pub message: String,
	pub line:    Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockModel {
	pub anchor:   String,
	pub kind:     BlockKind,
	pub text:     String,
	pub span:     SourceSpan,
	pub bounds:   LayoutBounds,
	pub editable: bool,
	pub reason:   Option<UnsupportedReason>,
	pub level:    Option<u8>,
	pub meta:     serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceState {
	pub ready:             bool,
	pub degraded:          bool,
	pub capability:        BackendCapability,
	pub capability_reason: Option<UnsupportedReason>,
	pub status_message:    String,
	pub document_version:  u32,
	pub viewport:          ViewportState,
	pub pages:             Vec<PageMetric>,
	pub diagnostics:       Vec<RenderDiagnostic>,
	pub blocks:            Vec<BlockModel>,
	pub last_error:        Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum HitTestResult {
	EditableSpan {
		anchor:     String,
		block_kind: BlockKind,
		span:       SourceSpan,
		bounds:     LayoutBounds,
	},
	NoneditablePreview {
		anchor:     String,
		block_kind: BlockKind,
		span:       SourceSpan,
		bounds:     LayoutBounds,
		reason:     UnsupportedReason,
	},
	OutsideDocument,
	Error {
		message: String,
	},
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
	pub force_degraded: bool,
}

impl SessionConfig {
	pub const fn new(force_degraded: bool) -> Self {
		Self { force_degraded }
	}
}

#[derive(Debug, Clone)]
pub struct SurfaceSession {
	config:       SessionConfig,
	source:       String,
	viewport:     ViewportState,
	state:        SurfaceState,
	svg_snapshot: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	#[error("{0}")]
	Message(String),
}

impl SurfaceSession {
	pub fn new(config: SessionConfig) -> Self {
		let viewport = ViewportState::default();
		let state = SurfaceState {
			ready:             false,
			degraded:          config.force_degraded,
			capability:        if config.force_degraded {
				BackendCapability::PreviewOnly
			} else {
				BackendCapability::Interactive
			},
			capability_reason: config
				.force_degraded
				.then_some(UnsupportedReason::ForcedFallback),
			status_message:    if config.force_degraded {
				"Interactive backend disabled; running in truthful preview-only mode.".to_string()
			} else {
				"Ready for interactive rendering.".to_string()
			},
			document_version:  0,
			viewport:          viewport.clone(),
			pages:             Vec::new(),
			diagnostics:       Vec::new(),
			blocks:            Vec::new(),
			last_error:        None,
		};
		Self { config, source: String::new(), viewport, state, svg_snapshot: String::new() }
	}

	pub fn state(&self) -> &SurfaceState {
		&self.state
	}

	pub fn snapshot_svg(&self) -> &str {
		&self.svg_snapshot
	}

	pub fn last_error(&self) -> Option<&str> {
		self.state.last_error.as_deref()
	}

	pub fn set_viewport(&mut self, viewport: ViewportState) -> SurfaceState {
		self.viewport = ViewportState {
			zoom:     viewport.zoom.max(0.25),
			width:    viewport.width.max(1.0),
			height:   viewport.height.max(1.0),
			scroll_x: viewport.scroll_x.max(0.0),
			scroll_y: viewport.scroll_y.max(0.0),
		};
		self.state.viewport = self.viewport.clone();
		self.rebuild_render();
		self.state.clone()
	}

	pub fn set_document(&mut self, source: impl Into<String>) -> SurfaceState {
		self.source = source.into();
		self.state.document_version = self.state.document_version.saturating_add(1);
		self.rebuild_render();
		self.state.clone()
	}

	pub fn hit_test(&self, x: f32, y: f32) -> HitTestResult {
		if self.svg_snapshot.is_empty() {
			return HitTestResult::Error { message: "No document loaded".to_string() };
		}
		let document_x = (x + self.viewport.scroll_x) / self.viewport.zoom.max(0.25);
		let document_y = (y + self.viewport.scroll_y) / self.viewport.zoom.max(0.25);
		for block in &self.state.blocks {
			let bounds = &block.bounds;
			if document_x >= bounds.x
				&& document_x <= bounds.x + bounds.width
				&& document_y >= bounds.y
				&& document_y <= bounds.y + bounds.height
			{
				if block.editable {
					return HitTestResult::EditableSpan {
						anchor:     block.anchor.clone(),
						block_kind: block.kind,
						span:       block.span.clone(),
						bounds:     bounds.clone(),
					};
				}
				return HitTestResult::NoneditablePreview {
					anchor:     block.anchor.clone(),
					block_kind: block.kind,
					span:       block.span.clone(),
					bounds:     bounds.clone(),
					reason:     block.reason.unwrap_or(UnsupportedReason::UnsupportedBlock),
				};
			}
		}
		HitTestResult::OutsideDocument
	}

	fn rebuild_render(&mut self) {
		let parsed = parse_document(&self.source, self.config.force_degraded);
		let rendered = render_document(&parsed.blocks, &self.viewport, &parsed.pages, &parsed.state);
		self.svg_snapshot = rendered.svg;
		self.state = parsed.state;
		self.state.viewport = self.viewport.clone();
		self.state.pages = rendered.pages;
		self.state.blocks = rendered.blocks;
	}
}

struct ParsedDocument {
	state:  SurfaceState,
	blocks: Vec<ParsedBlock>,
	pages:  Vec<PageMetric>,
}

#[derive(Debug, Clone)]
pub struct ParsedBlock {
	pub anchor:   String,
	pub kind:     BlockKind,
	pub text:     String,
	pub lines:    Vec<String>,
	pub span:     SourceSpan,
	pub editable: bool,
	pub reason:   Option<UnsupportedReason>,
	pub level:    Option<u8>,
	pub meta:     serde_json::Value,
}

fn parse_document(source: &str, force_degraded: bool) -> ParsedDocument {
	let mut diagnostics = collect_diagnostics(source);
	let mut blocks = Vec::new();
	let lines = source.lines().map(ToString::to_string).collect::<Vec<_>>();
	let mut index = 0usize;
	let mut anchor_index = 0u32;
	while index < lines.len() {
		let line = lines[index].trim_end().to_string();
		if line.trim().is_empty() {
			index += 1;
			continue;
		}
		anchor_index = anchor_index.saturating_add(1);
		let start_line = u32::try_from(index + 1).unwrap_or(u32::MAX);
		if let Some(level) = heading_level(&line) {
			blocks.push(ParsedBlock {
				anchor:   format!("block-{anchor_index}"),
				kind:     BlockKind::Heading,
				text:     line[(usize::from(level) + 1)..].trim().to_string(),
				lines:    vec![line.clone()],
				span:     SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: start_line,
					start_column: 1,
					end_column: u32::try_from(line.len() + 1).unwrap_or(u32::MAX),
				},
				editable: !force_degraded,
				reason:   force_degraded.then_some(UnsupportedReason::ForcedFallback),
				level:    Some(level),
				meta:     serde_json::json!({}),
			});
			index += 1;
			continue;
		}
		if is_variable_line(&line) {
			let (name, value) = parse_variable_line(&line);
			blocks.push(ParsedBlock {
				anchor:   format!("block-{anchor_index}"),
				kind:     BlockKind::Variable,
				text:     format!("{name} = {value}"),
				lines:    vec![line.clone()],
				span:     SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: start_line,
					start_column: 1,
					end_column: u32::try_from(line.len() + 1).unwrap_or(u32::MAX),
				},
				editable: !force_degraded,
				reason:   force_degraded.then_some(UnsupportedReason::ForcedFallback),
				level:    None,
				meta:     serde_json::json!({ "name": name, "value": value }),
			});
			index += 1;
			continue;
		}
		if is_image_line(&line) {
			let image_path = parse_image_path(&line);
			blocks.push(ParsedBlock {
				anchor:   format!("block-{anchor_index}"),
				kind:     BlockKind::Image,
				text:     image_path.clone().unwrap_or_else(|| "Image".to_string()),
				lines:    vec![line.clone()],
				span:     SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: start_line,
					start_column: 1,
					end_column: u32::try_from(line.len() + 1).unwrap_or(u32::MAX),
				},
				editable: !force_degraded,
				reason:   force_degraded.then_some(UnsupportedReason::ForcedFallback),
				level:    None,
				meta:     serde_json::json!({ "path": image_path }),
			});
			index += 1;
			continue;
		}
		if is_list_line(&line) {
			blocks.push(ParsedBlock {
				anchor:   format!("block-{anchor_index}"),
				kind:     BlockKind::ListItem,
				text:     line[2..].trim().to_string(),
				lines:    vec![line.clone()],
				span:     SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: start_line,
					start_column: 1,
					end_column: u32::try_from(line.len() + 1).unwrap_or(u32::MAX),
				},
				editable: !force_degraded,
				reason:   force_degraded.then_some(UnsupportedReason::ForcedFallback),
				level:    None,
				meta:     serde_json::json!({}),
			});
			index += 1;
			continue;
		}
		if is_table_line(&line) {
			let mut table_lines = vec![line.clone()];
			let mut end = index + 1;
			while end < lines.len() && is_table_line(lines[end].trim_end()) {
				table_lines.push(lines[end].trim_end().to_string());
				end += 1;
			}
			let table_text = table_lines.join("\n");
			blocks.push(ParsedBlock {
				anchor: format!("block-{anchor_index}"),
				kind: BlockKind::Table,
				text: table_text,
				lines: table_lines.clone(),
				span: SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: u32::try_from(end).unwrap_or(u32::MAX),
					start_column: 1,
					end_column: u32::try_from(table_lines.last().map_or(1, |value| value.len() + 1)).unwrap_or(u32::MAX),
				},
				editable: !force_degraded,
				reason: force_degraded.then_some(UnsupportedReason::ForcedFallback),
				level: None,
				meta: serde_json::json!({ "rows": table_lines.iter().map(|row| parse_table_cells(row)).collect::<Vec<_>>() }),
			});
			index = end;
			continue;
		}
		if is_unsupported_line(&line) {
			blocks.push(ParsedBlock {
				anchor:   format!("block-{anchor_index}"),
				kind:     BlockKind::Unsupported,
				text:     line.clone(),
				lines:    vec![line.clone()],
				span:     SourceSpan {
					anchor: format!("block-{anchor_index}"),
					start_line,
					end_line: start_line,
					start_column: 1,
					end_column: u32::try_from(line.len() + 1).unwrap_or(u32::MAX),
				},
				editable: false,
				reason:   Some(UnsupportedReason::UnsupportedSyntax),
				level:    None,
				meta:     serde_json::json!({}),
			});
			index += 1;
			continue;
		}
		let mut paragraph_lines = vec![line.clone()];
		let mut end = index + 1;
		while end < lines.len() {
			let next = lines[end].trim_end().to_string();
			if next.trim().is_empty()
				|| heading_level(&next).is_some()
				|| is_variable_line(&next)
				|| is_image_line(&next)
				|| is_list_line(&next)
				|| is_table_line(&next)
				|| is_unsupported_line(&next)
			{
				break;
			}
			paragraph_lines.push(next);
			end += 1;
		}
		let paragraph_text = paragraph_lines.join(" ");
		blocks.push(ParsedBlock {
			anchor:   format!("block-{anchor_index}"),
			kind:     BlockKind::Paragraph,
			text:     paragraph_text,
			lines:    paragraph_lines.clone(),
			span:     SourceSpan {
				anchor: format!("block-{anchor_index}"),
				start_line,
				end_line: u32::try_from(end).unwrap_or(u32::MAX),
				start_column: 1,
				end_column: u32::try_from(paragraph_lines.last().map_or(1, |value| value.len() + 1))
					.unwrap_or(u32::MAX),
			},
			editable: !force_degraded,
			reason:   force_degraded.then_some(UnsupportedReason::ForcedFallback),
			level:    None,
			meta:     serde_json::json!({}),
		});
		index = end;
	}

	let unsupported_count = blocks.iter().filter(|block| !block.editable).count();
	let syntax_error = diagnostics.iter().any(|diag| diag.code == "syntax_error");
	let capability = if syntax_error {
		BackendCapability::RecoveryOnly
	} else if force_degraded {
		BackendCapability::PreviewOnly
	} else if unsupported_count > 0 {
		BackendCapability::Mixed
	} else {
		BackendCapability::Interactive
	};
	let capability_reason = if syntax_error {
		Some(UnsupportedReason::SyntaxError)
	} else if force_degraded {
		Some(UnsupportedReason::ForcedFallback)
	} else if unsupported_count > 0 {
		Some(UnsupportedReason::UnsupportedSyntax)
	} else {
		None
	};
	if blocks.is_empty() && source.trim().is_empty() {
		diagnostics.push(RenderDiagnostic {
			code:    "empty_document".to_string(),
			message: "Document is empty; nothing to render yet.".to_string(),
			line:    None,
		});
	}
	let status_message = match capability {
		BackendCapability::Interactive => "Interactive native surface ready.".to_string(),
		BackendCapability::Mixed => "Some regions are preview-only because their Typst syntax is \
		                             unsupported for direct editing."
			.to_string(),
		BackendCapability::PreviewOnly => {
			"Interactive backend disabled; running in truthful preview-only mode.".to_string()
		},
		BackendCapability::RecoveryOnly => "Document has syntax issues or stale mapping; recovery \
		                                    mode is required until the source is repaired."
			.to_string(),
		BackendCapability::Failed => "Renderer failed to initialize.".to_string(),
	};
	ParsedDocument {
		state: SurfaceState {
			ready: true,
			degraded: matches!(
				capability,
				BackendCapability::PreviewOnly | BackendCapability::RecoveryOnly
			),
			capability,
			capability_reason,
			status_message,
			document_version: 0,
			viewport: ViewportState::default(),
			pages: Vec::new(),
			diagnostics,
			blocks: Vec::new(),
			last_error: None,
		},
		blocks,
		pages: Vec::new(),
	}
}

fn collect_diagnostics(source: &str) -> Vec<RenderDiagnostic> {
	let mut diagnostics = Vec::new();
	let mut paren_balance = 0i32;
	let mut bracket_balance = 0i32;
	let mut brace_balance = 0i32;
	for (index, line) in source.lines().enumerate() {
		for ch in line.chars() {
			match ch {
				'(' => paren_balance += 1,
				')' => paren_balance -= 1,
				'[' => bracket_balance += 1,
				']' => bracket_balance -= 1,
				'{' => brace_balance += 1,
				'}' => brace_balance -= 1,
				_ => {},
			}
		}
		if paren_balance < 0 || bracket_balance < 0 || brace_balance < 0 {
			diagnostics.push(RenderDiagnostic {
				code:    "syntax_error".to_string(),
				message: "Closing delimiter appears before its opener.".to_string(),
				line:    Some(u32::try_from(index + 1).unwrap_or(u32::MAX)),
			});
			return diagnostics;
		}
	}
	if paren_balance != 0 || bracket_balance != 0 || brace_balance != 0 {
		diagnostics.push(RenderDiagnostic {
			code:    "syntax_error".to_string(),
			message: "Document contains unbalanced delimiters; visual editing is disabled until \
			          recovery."
				.to_string(),
			line:    None,
		});
	}
	diagnostics
}

fn heading_level(line: &str) -> Option<u8> {
	let trimmed = line.trim_start();
	if !trimmed.starts_with('=') {
		return None;
	}
	let level = trimmed.chars().take_while(|ch| *ch == '=').count();
	if level == 0 || level > 6 {
		return None;
	}
	trimmed.chars().nth(level).filter(|ch| *ch == ' ')?;
	u8::try_from(level).ok()
}

fn is_variable_line(line: &str) -> bool {
	line.trim_start().starts_with("#let ")
}

fn is_image_line(line: &str) -> bool {
	line.trim_start().starts_with("#image(")
}

fn is_list_line(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("- ") || trimmed.starts_with("+ ")
}

fn is_table_line(line: &str) -> bool {
	line.trim_start().starts_with('|')
}

fn is_unsupported_line(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("#show")
		|| trimmed.starts_with("#for")
		|| trimmed.starts_with("#while")
		|| trimmed.starts_with("#raw")
		|| trimmed.starts_with("#context")
}

fn parse_variable_line(line: &str) -> (String, String) {
	let re = variable_regex();
	if let Some(caps) = re.captures(line.trim()) {
		let name = caps
			.get(1)
			.map_or("variable", |value| value.as_str())
			.to_string();
		let value = caps
			.get(2)
			.map_or("", |value| value.as_str())
			.trim()
			.to_string();
		return (name, value);
	}
	("variable".to_string(), line.trim().to_string())
}

fn parse_image_path(line: &str) -> Option<String> {
	let re = image_regex();
	re.captures(line.trim())
		.and_then(|caps| caps.get(1).map(|value| value.as_str().to_string()))
}

fn parse_table_cells(line: &str) -> Vec<String> {
	line
		.trim()
		.trim_matches('|')
		.split('|')
		.map(str::trim)
		.filter(|cell| !cell.is_empty())
		.map(ToString::to_string)
		.collect()
}

fn variable_regex() -> &'static Regex {
	static RE: OnceLock<Regex> = OnceLock::new();
	RE.get_or_init(|| {
		Regex::new(r"^#let\s+([A-Za-z0-9_-]+)\s*=\s*(.+)$").expect("valid variable regex")
	})
}

fn image_regex() -> &'static Regex {
	static RE: OnceLock<Regex> = OnceLock::new();
	RE.get_or_init(|| Regex::new(r#"^#image\(\s*\"([^\"]+)\""#).expect("valid image regex"))
}

pub fn page_width() -> f32 {
	PAGE_WIDTH
}

pub fn page_height() -> f32 {
	PAGE_HEIGHT
}

pub fn page_gap() -> f32 {
	PAGE_GAP
}

pub fn page_margin_x() -> f32 {
	PAGE_MARGIN_X
}

pub fn page_margin_y() -> f32 {
	PAGE_MARGIN_Y
}

impl SurfaceState {
	pub fn with_rendered(self, rendered: RenderedDocument) -> Self {
		Self { pages: rendered.pages, blocks: rendered.blocks, ..self }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_interactive_document_and_hit_tests_heading() {
		let mut session = SurfaceSession::new(SessionConfig::new(false));
		let state =
			session.set_document("= Welcome\n\nThis is a paragraph.\n\n- First item\n- Second item\n");
		assert_eq!(state.capability, BackendCapability::Interactive);
		assert!(session.snapshot_svg().contains("Welcome"));
		let hit = session.hit_test(120.0, 90.0);
		match hit {
			HitTestResult::EditableSpan { block_kind, span, .. } => {
				assert_eq!(block_kind, BlockKind::Heading);
				assert_eq!(span.start_line, 1);
			},
			other => panic!("expected editable hit, got {other:?}"),
		}
	}

	#[test]
	fn forces_truthful_preview_only_mode() {
		let mut session = SurfaceSession::new(SessionConfig::new(true));
		let state = session.set_document("= Fallback\n\nPreview only body.");
		assert_eq!(state.capability, BackendCapability::PreviewOnly);
		assert!(state.degraded);
		let hit = session.hit_test(140.0, 90.0);
		match hit {
			HitTestResult::NoneditablePreview { reason, .. } => {
				assert_eq!(reason, UnsupportedReason::ForcedFallback);
			},
			other => panic!("expected preview-only hit, got {other:?}"),
		}
	}

	#[test]
	fn enters_recovery_when_delimiters_are_unbalanced() {
		let mut session = SurfaceSession::new(SessionConfig::new(false));
		let state = session.set_document("= Broken\n\n#image(\"hero.png\"\n");
		assert_eq!(state.capability, BackendCapability::RecoveryOnly);
		assert!(
			state
				.diagnostics
				.iter()
				.any(|diag| diag.code == "syntax_error")
		);
	}

	#[test]
	fn marks_unsupported_constructs_without_disabling_whole_document() {
		let mut session = SurfaceSession::new(SessionConfig::new(false));
		let state =
			session.set_document("= Title\n\n#show heading: set text(fill: red)\n\nParagraph");
		assert_eq!(state.capability, BackendCapability::Mixed);
		let unsupported = state
			.blocks
			.iter()
			.find(|block| block.kind == BlockKind::Unsupported)
			.expect("unsupported block present");
		assert_eq!(unsupported.reason, Some(UnsupportedReason::UnsupportedSyntax));
	}
}
