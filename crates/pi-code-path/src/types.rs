use std::{collections::HashMap, ops::Range};

use serde::{Deserialize, Serialize};

/// The unified return shape from CodePath resolution.
/// Every node in the result set is a `NodeRef` with optional content
/// populated only when the path includes a content-class qualifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRef {
	/// Canonical CodePath locator for this node.
	pub locator:     String,
	/// Byte range within the source buffer.
	pub range:       Range<usize>,
	/// The node kind (e.g. §function, §line, §dir, etc.).
	pub kind:        String,
	/// Content, populated only when path includes a content-class qualifier
	/// (#raw, #text, #body, #image, etc.).
	pub content:     Option<Content>,
	/// Dialect-specific metadata (capture groups for text-regex,
	/// size/mtime for FS-stat, language/exports for code, jq-path for JSON).
	#[serde(default)]
	pub metadata:    HashMap<String, serde_json::Value>,
	/// Per-node diagnostics (e.g. permission denied for FS entry).
	#[serde(default)]
	pub diagnostics: Vec<Diagnostic>,
}
impl NodeRef {
	/// Return a canonical (locator, range) key for deduplication.
	pub fn canonical_locator(&self) -> (&str, std::ops::Range<usize>) {
		(&self.locator, self.range.clone())
	}
}
// ── Content ──────────────────────────────────────────────────────

/// Content payload — what lives at a node.
/// Binary content is NEVER inlined; it is staged to the artifact store
/// and returned as an artifact:// handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Content {
	/// Plain text content.
	Text { value: String },
	/// Binary content — an artifact:// handle.
	Bytes { artifact_uri: String, size: u64 },
	/// Image content — a handle (artifact:// or image://).
	Image {
		handle:    String,
		mime_type: String,
		width:     Option<u32>,
		height:    Option<u32>,
		bytes:     Option<Vec<u8>>,
	},
	/// Extracted/converted text from a non-text source.
	ExtractedText {
		/// Kind of the source (pdf, docx, json, html, ...).
		source_kind: String,
		text:        String,
		/// Original MIME type.
		mime_type:   Option<String>,
	},
}

// ── Diagnostic ────────────────────────────────────────────────────

/// A diagnostic produced during CodePath resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
	pub variant: DiagnosticVariant,
	pub message: String,
	/// Optional span in the CodePath source string.
	pub span:    Option<Span>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticVariant {
	ParseError,
	/// Locator not found.
	FileNotFound,
	ArtifactNotFound,
	MemoryPathNotFound,
	SkillNotFound,
	AgentNotFound,
	JobNotFound,
	PiPathNotFound,
	/// Unknown URI scheme, with hint of available schemes.
	UnknownLocatorScheme {
		available: Vec<String>,
	},
	/// Suffix/typo suggestion when zero matches found.
	SuffixSuggestion {
		tried:      String,
		suggestion: String,
	},
	/// Zero nodes matched.
	NoMatches,
	/// Multiple nodes matched for a single-target operation.
	AmbiguousTarget {
		count: usize,
	},
	/// The resolver does not support the requested operation.
	UnsupportedOperation,
	/// Edit command invoked without actions.
	MissingActions,
	/// No resolver supports the requested action kind.
	UnsupportedActionForResolver,
	/// Permission denied when accessing a filesystem entry.
	Inaccessible,
	/// Encoding fallback (e.g. latin-1 for non-UTF-8 file).
	EncodingFallback,
	/// The requested scheme is not implemented in this release.
	SchemeNotImplemented,
	/// Target file already exists.
	FileExists,
	/// Anchor hash mismatch — file changed since read.
	StaleAnchor,
	/// Delete would leave the file at zero bytes; use a bare-path target to
	/// remove the file.
	ZeroByteDeleteBlocked,
	/// Timeout or cancellation.
	Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
	pub start: usize,
	pub end:   usize,
}

// ── Chunk for streaming ──────────────────────────────────────────

/// Emitted by the streaming resolver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodePathChunk {
	pub nodes:       Vec<NodeRef>,
	pub done:        bool,
	#[serde(default)]
	pub diagnostics: Vec<Diagnostic>,
}
