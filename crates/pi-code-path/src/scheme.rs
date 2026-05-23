//! Declarative `SchemeProfile` DSL for URI scheme resolution.
//!
//! Mirrors the language-dialect pattern (`dialect.rs`) but for URIs. Each
//! scheme is a declarative profile pinning four axes:
//!
//! - **Root**         — where the scheme's namespace anchors (project / session
//!   / user / virtual)
//! - **Layout**       — how the URI body maps to an address under that root
//! - **Loader**       — how the address materializes into bytes
//! - **Capabilities** — what the kernel may subsequently do with the result
//!
//! Authority: `crates/pi-natives/src/code_path/uri/<scheme>.rs` registers
//! one `SchemeProfile` per file; `build.rs` auto-collects them. Runtime
//! callbacks (canvas, MCP-advertised) register via NAPI at session-init.
//!
//! Per PLAN-310: this replaces FEAT-721's TS-side `InternalUrlRouter`.
//! The kernel becomes the single source of truth for URI dispatch.

use std::{
	collections::HashMap,
	ops::Range,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use crate::{
	ast::UriLocator,
	resolver::traits::CancellationToken,
	types::{Content, Diagnostic, DiagnosticVariant},
};

// ── SessionContext ───────────────────────────────────────────────

/// Per-call kernel context passed by reference.
///
/// Threaded as `Option<&SessionContext>` through every kernel API surface
/// that may resolve URIs. `None` is the anonymous/test mode — schemes that
/// require session data (`SessionRoot`, callback-backed) will fail loudly.
#[derive(Debug, Clone)]
pub struct SessionContext {
	pub project_root: PathBuf,
	pub session_dir:  Option<PathBuf>,
	pub home:         PathBuf,
}

impl SessionContext {
	pub fn new(project_root: impl Into<PathBuf>, home: impl Into<PathBuf>) -> Self {
		Self { project_root: project_root.into(), session_dir: None, home: home.into() }
	}

	pub fn with_session_dir(mut self, dir: impl Into<PathBuf>) -> Self {
		self.session_dir = Some(dir.into());
		self
	}
}

// ── RootTemplate ─────────────────────────────────────────────────

/// Anchor for the scheme's content namespace.
#[derive(Clone, Debug)]
pub enum RootTemplate {
	/// `<project_root>/<rel>`        e.g. `.spell/skills`
	ProjectRoot { rel: PathBuf },
	/// `<session_dir>/<rel>`         e.g. `agent-outputs`
	SessionRoot { rel: PathBuf },
	/// `<home>/<rel>`                e.g. `.org`
	UserRoot { rel: PathBuf },
	/// Arbitrary absolute path.
	AbsoluteRoot { path: PathBuf },
	/// No filesystem root; loader produces content directly.
	Virtual,
}

impl RootTemplate {
	/// Resolve to an absolute path, given session context.
	/// Returns `None` for `Virtual`. Errors when required context is missing.
	pub fn resolve(&self, ctx: Option<&SessionContext>) -> Result<Option<PathBuf>, Diagnostic> {
		match self {
			Self::ProjectRoot { rel } => match ctx {
				Some(c) => Ok(Some(c.project_root.join(rel))),
				None => Err(ctx_required("ProjectRoot")),
			},
			Self::SessionRoot { rel } => match ctx.and_then(|c| c.session_dir.as_ref()) {
				Some(dir) => Ok(Some(dir.join(rel))),
				None => Err(ctx_required("SessionRoot")),
			},
			Self::UserRoot { rel } => match ctx {
				Some(c) => Ok(Some(c.home.join(rel))),
				None => Err(ctx_required("UserRoot")),
			},
			Self::AbsoluteRoot { path } => Ok(Some(path.clone())),
			Self::Virtual => Ok(None),
		}
	}
}

fn ctx_required(template: &str) -> Diagnostic {
	Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("scheme requires SessionContext for {template}"),
		span:    None,
	}
}

// ── PathLayout ───────────────────────────────────────────────────

/// How the URI body parses to an address within the root.
#[derive(Clone, Debug)]
pub enum PathLayout {
	/// Body is taken verbatim as subpath.
	/// `local://foo/bar.md` → `<root>/foo/bar.md`
	Direct,

	/// Body is `<name>[/<subpath>]`. Bare name appends `entry_file`.
	/// `skill://canvas`              → `<root>/canvas/SKILL.md`
	/// `skill://canvas/scripts/x.py` → `<root>/canvas/scripts/x.py`
	NamedDir { entry_file: String, subpath_allowed: bool },

	/// Body is `<namespace>[/<subpath>]` where `<namespace>` must equal the
	/// configured value. Unlike `NamedDir`, the namespace is NOT used as a path
	/// segment — it's a gate. Bare namespace resolves to `default_file`.
	/// `memory://root`         → `<root>/memory_summary.md`
	/// `memory://root/foo.md`  → `<root>/foo.md`
	Namespaced { namespace: String, default_file: String, subpath_allowed: bool },

	/// Body is `<name>`. Append fixed extension.
	/// `rule://canvas` → `<root>/canvas.md`
	NamedFile { extension: String },

	/// Body is `<id>[#<fragment>]`. Fragments select files under `<root>/<id>/`.
	IdFragment { default: FragmentEntry, fragments: HashMap<String, FragmentEntry> },

	/// Body is opaque; loader's `Indexed` mode performs the lookup.
	Indexed,
}

/// Where an `IdFragment` entry resolves to within `<root>/<id>/`.
#[derive(Clone, Debug)]
pub enum FragmentEntry {
	/// Single file relative to `<root>/<id>/`.
	File(String),
	/// Synthesize content by combining multiple files.
	Synth(SynthSpec),
}

#[derive(Clone, Debug)]
pub struct SynthSpec {
	/// `(label, filename)` pairs read from `<root>/<id>/`.
	pub parts:   Vec<(String, String)>,
	pub reducer: SynthReducer,
}

#[derive(Clone)]
pub enum SynthReducer {
	/// `"label: <content>\n…"`. Missing parts skipped silently.
	LabeledConcat,
	/// Concatenate raw content, no labels. Missing parts skipped.
	RawConcat,
	/// Escape hatch. Marked for DSL extension when used.
	Custom(Arc<dyn Fn(&[(&str, Option<&str>)]) -> String + Send + Sync>),
}

impl std::fmt::Debug for SynthReducer {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::LabeledConcat => f.write_str("LabeledConcat"),
			Self::RawConcat => f.write_str("RawConcat"),
			Self::Custom(_) => f.write_str("Custom(fn)"),
		}
	}
}

/// Parsed match result from running `PathLayout::parse` on a URI body.
#[derive(Debug, Clone)]
pub struct LayoutMatch {
	/// Subpath under the resolved root (None for `Indexed` — loader handles).
	pub path:     Option<PathBuf>,
	/// Fragment selector (only meaningful for `IdFragment`).
	pub fragment: Option<String>,
	/// Id (only meaningful for `IdFragment` + `Indexed`).
	pub id:       Option<String>,
}

impl PathLayout {
	/// Parse the URI's body into an address description.
	pub fn parse(&self, body: &str) -> Result<LayoutMatch, Diagnostic> {
		match self {
			Self::Direct => {
				Ok(LayoutMatch { path: Some(PathBuf::from(body)), fragment: None, id: None })
			},

			Self::NamedDir { entry_file, subpath_allowed } => {
				if body.is_empty() {
					return Err(layout_err("NamedDir requires a name"));
				}
				let (name, rest) = body.split_once('/').unwrap_or((body, ""));
				if name.is_empty() {
					return Err(layout_err("NamedDir name must not be empty"));
				}
				let mut p = PathBuf::from(name);
				if rest.is_empty() {
					p.push(entry_file);
				} else if *subpath_allowed {
					p.push(rest);
				} else {
					return Err(layout_err("subpath not allowed for this scheme"));
				}
				Ok(LayoutMatch { path: Some(p), fragment: None, id: None })
			},

			Self::Namespaced { namespace, default_file, subpath_allowed } => {
				if body.is_empty() {
					return Err(layout_err(&format!(
						"Namespaced layout requires '{namespace}' namespace: {namespace}://[/subpath]"
					)));
				}
				let (ns, rest) = body.split_once('/').unwrap_or((body, ""));
				if ns != namespace {
					return Err(layout_err(&format!(
						"unknown namespace '{ns}'; supported: {namespace}"
					)));
				}
				let p = if rest.is_empty() {
					PathBuf::from(default_file)
				} else if *subpath_allowed {
					PathBuf::from(rest)
				} else {
					return Err(layout_err("subpath not allowed for this scheme"));
				};
				Ok(LayoutMatch { path: Some(p), fragment: None, id: None })
			},

			Self::NamedFile { extension } => {
				if body.is_empty() || body.contains('/') {
					return Err(layout_err("NamedFile expects a bare name"));
				}
				Ok(LayoutMatch {
					path:     Some(PathBuf::from(format!("{body}.{extension}"))),
					fragment: None,
					id:       None,
				})
			},

			Self::IdFragment { .. } => {
				let (id, fragment) = body
					.split_once('#')
					.map_or((body, None), |(i, f)| (i, Some(f.to_string())));
				if id.is_empty() {
					return Err(layout_err("IdFragment requires an id"));
				}
				Ok(LayoutMatch {
					path: None, // loader resolves via SynthSpec / FragmentEntry::File
					fragment,
					id: Some(id.to_string()),
				})
			},

			Self::Indexed => {
				Ok(LayoutMatch { path: None, fragment: None, id: Some(body.to_string()) })
			},
		}
	}
}

fn layout_err(msg: &str) -> Diagnostic {
	Diagnostic { variant: DiagnosticVariant::ParseError, message: msg.to_string(), span: None }
}

// ── ContentLoader ────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub enum ReadMode {
	Utf8Text,
	Binary,
	/// Try utf8; fall back to binary on invalid utf8.
	Auto,
}

/// Materializes a resolved address into bytes.
#[derive(Clone)]
pub enum ContentLoader {
	/// Single-file read at the resolved path.
	FsRead { mode: ReadMode },
	/// Embedded compile-time table. Used by `pi://`.
	Static { table: &'static phf::Map<&'static str, &'static str> },
	/// Indexed loader — body is an id, lookup produces (path, range).
	/// `read_mode` controls binary handling: `Utf8Text` for known-text
	/// indices (org), `Auto` for indices that may resolve to binary
	/// content (artifact images/pdfs).
	Indexed { lookup: Arc<dyn IndexLookup>, read_mode: ReadMode },
	/// Callback escape hatch — JS-resident schemes.
	Callback(Arc<dyn SchemeCallback>),
}

impl std::fmt::Debug for ContentLoader {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::FsRead { mode } => f.debug_struct("FsRead").field("mode", mode).finish(),
			Self::Static { .. } => f.write_str("Static"),
			Self::Indexed { .. } => f.write_str("Indexed"),
			Self::Callback(_) => f.write_str("Callback"),
		}
	}
}

/// Lookup for `PathLayout::Indexed` schemes (e.g. `org://` task-id → file
/// path).
pub trait IndexLookup: Send + Sync {
	fn lookup(
		&self,
		body: &str,
		ctx: Option<&SessionContext>,
		cancel: &CancellationToken,
	) -> Result<ResolvedAddress, Diagnostic>;
}

#[derive(Debug, Clone)]
pub struct ResolvedAddress {
	pub path:  PathBuf,
	/// Optional byte-range within the file (used by `org://` for heading
	/// regions).
	pub range: Option<Range<usize>>,
	/// Per-resolution notes appended to the resulting ResolvedContent. Use for
	/// dynamic hints that depend on the lookup result (e.g. org item title).
	pub notes: Vec<String>,
}

/// Callback contract for runtime-registered schemes (canvas, MCP-advertised).
pub trait SchemeCallback: Send + Sync {
	fn resolve(
		&self,
		body: &str,
		ctx: Option<&SessionContext>,
		cancel: &CancellationToken,
	) -> Result<ResolvedContent, Diagnostic>;
}

// ── Capabilities + Cache ─────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum CacheStrategy {
	/// Always re-resolve.
	None,
	/// Cache while source_path mtime unchanged. Requires `fs_backed`.
	UntilMtimeChange,
	/// Cache for fixed duration. For `Callback` schemes.
	Ttl(Duration),
}

impl Default for CacheStrategy {
	fn default() -> Self {
		Self::None
	}
}

#[derive(Clone, Debug, Default)]
pub struct SchemeCapabilities {
	/// Resolved `source_path` is a real fs path: enables codepath suffix
	/// forwarding.
	pub fs_backed:           bool,
	/// `<uri>::<codepath-suffix>` (`::Symbol`, `::§line[…]`, `#tree`) is
	/// supported. Implies `fs_backed`.
	pub codepath_compatible: bool,
	/// MIME hint surfaced to renderers.
	pub mime_hint:           Option<&'static str>,
	/// Caching policy.
	pub cache:               CacheStrategy,
	/// Whether this scheme may be expanded inside bash commands (brush
	/// integration). Requires `fs_backed`.
	pub bash_expandable:     bool,
	/// For `Callback` loader: max time to wait before timeout. None = no
	/// timeout.
	pub callback_budget:     Option<Duration>,
	/// Static notes appended to every successful resolution. Use for
	/// scheme-wide hints (e.g. write-path reminders for `local://`).
	pub static_notes:        &'static [&'static str],
}

// ── SchemeProfile ────────────────────────────────────────────────

/// One complete declarative profile for a URI scheme.
#[derive(Clone, Debug)]
pub struct SchemeProfile {
	pub scheme:       &'static str,
	pub root:         RootTemplate,
	pub layout:       PathLayout,
	pub loader:       ContentLoader,
	pub capabilities: SchemeCapabilities,
}

// ── ResolvedContent ──────────────────────────────────────────────

/// What the registry returns to callers after dispatch.
#[derive(Debug, Clone)]
pub struct ResolvedContent {
	pub url:          String,
	/// `Some(_)` when the resolved address is a real fs path; gates codepath
	/// forwarding.
	pub source_path:  Option<PathBuf>,
	pub content:      Content,
	pub mime:         Option<String>,
	pub notes:        Vec<String>,
	/// Internal: mtime at read time (for `UntilMtimeChange` cache invalidation).
	#[doc(hidden)]
	pub source_mtime: Option<SystemTime>,
}

impl ResolvedContent {
	pub fn text(url: String, source_path: Option<PathBuf>, value: String) -> Self {
		Self {
			url,
			source_path,
			content: Content::Text { value },
			mime: None,
			notes: Vec::new(),
			source_mtime: None,
		}
	}

	/// Prepend static notes from the profile capabilities to dynamic notes.
	pub fn with_static_notes(mut self, statics: &[&'static str]) -> Self {
		if !statics.is_empty() {
			let mut combined: Vec<String> = statics.iter().map(|s| s.to_string()).collect();
			combined.extend(self.notes.drain(..));
			self.notes = combined;
		}
		self
	}
}

// ── Cache key + entries ──────────────────────────────────────────

/// Per-(scheme,body) cache key.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CacheKey {
	pub scheme: String,
	pub body:   String,
}

#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct TtlEntry {
	pub content:    Arc<ResolvedContent>,
	pub expires_at: Instant,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn root_project_resolves() {
		let ctx = SessionContext::new("/proj", "/home/u");
		let r = RootTemplate::ProjectRoot { rel: ".spell/skills".into() };
		assert_eq!(r.resolve(Some(&ctx)).unwrap(), Some(PathBuf::from("/proj/.spell/skills")));
	}

	#[test]
	fn root_session_needs_ctx() {
		let ctx_no = SessionContext::new("/proj", "/home/u");
		let r = RootTemplate::SessionRoot { rel: "x".into() };
		assert!(r.resolve(Some(&ctx_no)).is_err());
		let ctx_yes = SessionContext::new("/proj", "/home/u").with_session_dir("/sess");
		assert_eq!(r.resolve(Some(&ctx_yes)).unwrap(), Some(PathBuf::from("/sess/x")));
	}

	#[test]
	fn root_user_resolves() {
		let ctx = SessionContext::new("/proj", "/home/u");
		let r = RootTemplate::UserRoot { rel: ".org".into() };
		assert_eq!(r.resolve(Some(&ctx)).unwrap(), Some(PathBuf::from("/home/u/.org")));
	}

	#[test]
	fn root_virtual_returns_none() {
		let r = RootTemplate::Virtual;
		assert_eq!(r.resolve(None).unwrap(), None);
	}

	#[test]
	fn layout_direct() {
		let l = PathLayout::Direct;
		let m = l.parse("foo/bar.md").unwrap();
		assert_eq!(m.path, Some(PathBuf::from("foo/bar.md")));
	}

	#[test]
	fn layout_named_dir_bare_appends_entry() {
		let l = PathLayout::NamedDir { entry_file: "SKILL.md".into(), subpath_allowed: true };
		let m = l.parse("canvas").unwrap();
		assert_eq!(m.path, Some(PathBuf::from("canvas/SKILL.md")));
	}

	#[test]
	fn layout_named_dir_subpath() {
		let l = PathLayout::NamedDir { entry_file: "SKILL.md".into(), subpath_allowed: true };
		let m = l.parse("canvas/scripts/init.py").unwrap();
		assert_eq!(m.path, Some(PathBuf::from("canvas/scripts/init.py")));
	}

	#[test]
	fn layout_named_dir_subpath_disallowed() {
		let l = PathLayout::NamedDir { entry_file: "RULE.md".into(), subpath_allowed: false };
		assert!(l.parse("foo/bar").is_err());
	}

	#[test]
	fn layout_named_file_appends_ext() {
		let l = PathLayout::NamedFile { extension: "md".into() };
		let m = l.parse("canvas").unwrap();
		assert_eq!(m.path, Some(PathBuf::from("canvas.md")));
	}

	#[test]
	fn layout_named_file_rejects_subpath() {
		let l = PathLayout::NamedFile { extension: "md".into() };
		assert!(l.parse("foo/bar").is_err());
	}

	#[test]
	fn layout_idfragment_splits() {
		let l = PathLayout::IdFragment {
			default:   FragmentEntry::File("status.txt".into()),
			fragments: HashMap::new(),
		};
		let m = l.parse("job123").unwrap();
		assert_eq!(m.id.as_deref(), Some("job123"));
		assert_eq!(m.fragment, None);

		let m2 = l.parse("job123#status").unwrap();
		assert_eq!(m2.id.as_deref(), Some("job123"));
		assert_eq!(m2.fragment.as_deref(), Some("status"));
	}

	#[test]
	fn layout_indexed_body_is_id() {
		let l = PathLayout::Indexed;
		let m = l.parse("FEAT-123").unwrap();
		assert_eq!(m.id.as_deref(), Some("FEAT-123"));
		assert_eq!(m.path, None);
	}

	#[test]
	fn capabilities_default() {
		let c = SchemeCapabilities::default();
		assert!(!c.fs_backed);
		assert!(!c.codepath_compatible);
		assert!(matches!(c.cache, CacheStrategy::None));
	}
}
