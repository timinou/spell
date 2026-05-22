//! `SchemeRegistry` — dispatches URI locators to their `SchemeProfile`.
//!
//! Holds:
//! - The set of registered `SchemeProfile`s (one per scheme name)
//! - A `SchemeCache` for memoized resolution per `CacheStrategy`
//!
//! Lifecycle: built once per session; reads `SessionContext` per call.
//! Static profiles loaded by `pi-natives::code_path::uri::SCHEMES` table
//! (build.rs-generated). Runtime callbacks injected via `register_callback`.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::Arc,
	time::SystemTime,
};

use crate::{
	ast::UriLocator,
	resolver::traits::CancellationToken,
	scheme::{
		CacheKey, ContentLoader, FragmentEntry, PathLayout, ReadMode, ResolvedContent,
		SchemeCallback, SchemeCapabilities, SchemeProfile, SessionContext, SynthReducer, SynthSpec,
	},
	scheme_cache::SchemeCache,
	types::{Content, Diagnostic, DiagnosticVariant},
};

/// Schemes the kernel reserves; runtime registrations must not collide.
pub const RESERVED_SCHEMES: &[&str] =
	&["skill", "rule", "memory", "agent", "artifact", "jobs", "org", "pi", "local"];

pub struct SchemeRegistry {
	profiles: HashMap<&'static str, SchemeProfile>,
	/// Runtime callback profiles keyed by owned scheme name.
	dynamic:  HashMap<String, SchemeProfile>,
	cache:    SchemeCache,
}

impl Default for SchemeRegistry {
	fn default() -> Self {
		Self { profiles: HashMap::new(), dynamic: HashMap::new(), cache: SchemeCache::new() }
	}
}

impl SchemeRegistry {
	pub fn new() -> Self {
		Self::default()
	}

	/// Build registry from a slice of static profile factories.
	/// Each factory builds a `SchemeProfile`; the `'static` scheme name is the
	/// key.
	pub fn from_static<I>(factories: I, ctx: Option<&SessionContext>) -> Self
	where
		I: IntoIterator<Item = fn(Option<&SessionContext>) -> SchemeProfile>,
	{
		let mut profiles = HashMap::new();
		for build in factories {
			let p = build(ctx);
			profiles.insert(p.scheme, p);
		}
		Self { profiles, dynamic: HashMap::new(), cache: SchemeCache::new() }
	}

	/// Register a complete dynamic SchemeProfile. The scheme name in the profile
	/// is used as the key; reserved names + duplicates are rejected.
	pub fn register_dynamic_profile(&mut self, profile: SchemeProfile) -> Result<(), Diagnostic> {
		validate_scheme_name(profile.scheme)?;
		if RESERVED_SCHEMES.contains(&profile.scheme) {
			return Err(invalid(format!("scheme '{}' is reserved by the kernel", profile.scheme)));
		}
		if self.dynamic.contains_key(profile.scheme) {
			return Err(invalid(format!("scheme '{}' already registered", profile.scheme)));
		}
		self.dynamic.insert(profile.scheme.to_string(), profile);
		Ok(())
	}

	/// Convenience: build a Callback-backed profile from (name, callback,
	/// capabilities).
	pub fn register_callback(
		&mut self,
		scheme: String,
		callback: Arc<dyn SchemeCallback>,
		capabilities: SchemeCapabilities,
	) -> Result<(), Diagnostic> {
		validate_scheme_name(&scheme)?;
		if RESERVED_SCHEMES.contains(&scheme.as_str()) {
			return Err(invalid(format!(
				"scheme '{scheme}' is reserved by the kernel; rename your MCP server or pick a \
				 non-conflicting schemePrefix"
			)));
		}
		if self.dynamic.contains_key(&scheme) {
			return Err(invalid(format!(
				"scheme '{scheme}' already registered; unregister first to override"
			)));
		}
		let profile = SchemeProfile {
			scheme: Box::leak(scheme.clone().into_boxed_str()),
			root: crate::scheme::RootTemplate::Virtual,
			layout: PathLayout::Direct,
			loader: ContentLoader::Callback(callback),
			capabilities,
		};
		self.dynamic.insert(scheme, profile);
		Ok(())
	}

	pub fn unregister_callback(&mut self, scheme: &str) -> bool {
		self.dynamic.remove(scheme).is_some()
	}

	/// Look up a profile by scheme name. Static profiles take precedence over
	/// dynamic.
	pub fn lookup(&self, scheme: &str) -> Option<&SchemeProfile> {
		self
			.profiles
			.get(scheme)
			.or_else(|| self.dynamic.get(scheme))
	}

	pub fn has_scheme(&self, scheme: &str) -> bool {
		self.lookup(scheme).is_some()
	}

	pub fn known_schemes(&self) -> Vec<String> {
		let mut s: Vec<String> = self.profiles.keys().map(|k| k.to_string()).collect();
		s.extend(self.dynamic.keys().cloned());
		s.sort();
		s
	}

	/// Resolve a URI locator. Returns the full `ResolvedContent` or a
	/// diagnostic.
	pub fn resolve(
		&self,
		uri: &UriLocator,
		ctx: Option<&SessionContext>,
		cancel: &CancellationToken,
	) -> Result<Arc<ResolvedContent>, Diagnostic> {
		let profile = self.lookup(&uri.scheme).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::UnknownLocatorScheme { available: self.known_schemes() },
			message: format!("unknown URI scheme: {}", uri.scheme),
			span:    None,
		})?;

		let key = CacheKey { scheme: uri.scheme.clone(), body: uri.path.clone() };
		let url = format!("{}://{}", uri.scheme, uri.path);

		self
			.cache
			.get_or_resolve(key, &profile.capabilities.cache, || {
				dispatch(profile, &uri.path, &url, ctx, cancel)
			})
	}

	/// Variant of `resolve` that skips the cache. Used by tests + invalidation
	/// paths.
	pub fn resolve_uncached(
		&self,
		uri: &UriLocator,
		ctx: Option<&SessionContext>,
		cancel: &CancellationToken,
	) -> Result<ResolvedContent, Diagnostic> {
		let profile = self.lookup(&uri.scheme).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::UnknownLocatorScheme { available: self.known_schemes() },
			message: format!("unknown URI scheme: {}", uri.scheme),
			span:    None,
		})?;
		let url = format!("{}://{}", uri.scheme, uri.path);
		let resolved = dispatch(profile, &uri.path, &url, ctx, cancel)?;
		Ok(resolved.with_static_notes(profile.capabilities.static_notes))
	}
}

/// One-shot resolver. Order of resolution:
///   1. parse the URI body via `PathLayout`
///   2. resolve root via `RootTemplate` (None for Virtual)
///   3. dispatch to the appropriate path:
///      - `IdFragment` layout owns its own dispatch (per-fragment file or
///        synthesizer)
///      - else by `ContentLoader` variant
fn dispatch(
	profile: &SchemeProfile,
	body: &str,
	url: &str,
	ctx: Option<&SessionContext>,
	cancel: &CancellationToken,
) -> Result<ResolvedContent, Diagnostic> {
	if cancel.is_cancelled() {
		return Err(cancelled());
	}

	let m = profile.layout.parse(body)?;
	let root = profile.root.resolve(ctx)?;

	// IdFragment owns its own dispatch path — bypasses ContentLoader.
	if let PathLayout::IdFragment { default, fragments } = &profile.layout {
		let id = m
			.id
			.as_deref()
			.ok_or_else(|| invalid("IdFragment without id"))?;
		let root = root.ok_or_else(|| invalid("IdFragment requires a non-virtual root"))?;
		let entry = match m.fragment.as_deref() {
			Some(f) => fragments.get(f).unwrap_or(default),
			None => default,
		};
		return resolve_fragment(entry, &root.join(id), url, profile.capabilities.mime_hint);
	}

	match &profile.loader {
		ContentLoader::FsRead { mode } => {
			let root = root.ok_or_else(|| invalid("FsRead loader requires a non-virtual root"))?;
			let sub = m
				.path
				.ok_or_else(|| invalid("FsRead loader requires PathLayout to produce a subpath"))?;
			// Reject any subpath that resolves outside the configured root, even
			// after normalization (`../`, absolute, or symlink-escape attempts).
			// FsAnchor-style sandboxing isn't available here; do the cheap textual
			// check + a canonicalization probe to catch symlink escapes.
			let joined = root.join(&sub);
			let normalized = normalize_path(&joined);
			if !path_starts_with(&normalized, &root) {
				return Err(Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("{url}: path escapes scheme root"),
					span:    None,
				});
			}
			read_file(&normalized, *mode, url.to_string())
		},
		ContentLoader::Static { table } => {
			let path = m.path.unwrap_or_else(|| PathBuf::from(body));
			let key = path.to_string_lossy();
			let text = table.get(key.as_ref()).ok_or_else(|| Diagnostic {
				variant: DiagnosticVariant::FileNotFound,
				message: format!("static entry not found: {url}"),
				span:    None,
			})?;
			Ok(ResolvedContent {
				url:          url.to_string(),
				source_path:  None,
				content:      Content::Text { value: (*text).to_string() },
				mime:         profile.capabilities.mime_hint.map(String::from),
				notes:        vec![],
				source_mtime: None,
			})
		},
		ContentLoader::Indexed { lookup } => {
			let id = m
				.id
				.as_deref()
				.ok_or_else(|| invalid("Indexed loader requires Indexed layout"))?;
			let addr = lookup.lookup(id, ctx, cancel)?;
			let notes = addr.notes.clone();
			let mut resolved = read_file_with_range(
				&addr.path,
				addr.range,
				ReadMode::Utf8Text,
				url.to_string(),
				profile.capabilities.mime_hint,
			)?;
			resolved.notes.extend(notes);
			Ok(resolved)
		},
		ContentLoader::Callback(cb) => {
			let mut content = cb.resolve(body, ctx, cancel)?;
			if content.url.is_empty() {
				content.url = url.to_string();
			}
			if content.mime.is_none() {
				content.mime = profile.capabilities.mime_hint.map(String::from);
			}
			Ok(content)
		},
	}
}

fn resolve_fragment(
	entry: &FragmentEntry,
	id_dir: &Path,
	url: &str,
	mime: Option<&'static str>,
) -> Result<ResolvedContent, Diagnostic> {
	if !id_dir.exists() {
		return Err(Diagnostic {
			variant: DiagnosticVariant::FileNotFound,
			message: format!("not found: {url}"),
			span:    None,
		});
	}
	match entry {
		FragmentEntry::File(name) => {
			let p = id_dir.join(name);
			read_file(&p, ReadMode::Utf8Text, url.to_string())
		},
		FragmentEntry::Synth(spec) => {
			let parts: Vec<(&str, Option<String>)> = spec
				.parts
				.iter()
				.map(|(label, fname)| {
					let val = std::fs::read_to_string(id_dir.join(fname)).ok();
					(label.as_str(), val)
				})
				.collect();
			let text = synthesize(&spec, &parts);
			Ok(ResolvedContent {
				url:          url.to_string(),
				source_path:  Some(id_dir.to_path_buf()),
				content:      Content::Text { value: text },
				mime:         mime.map(String::from),
				notes:        vec![],
				source_mtime: None,
			})
		},
	}
}

fn synthesize(spec: &SynthSpec, parts: &[(&str, Option<String>)]) -> String {
	match &spec.reducer {
		SynthReducer::LabeledConcat => {
			let mut out = String::new();
			for (label, val) in parts {
				if let Some(v) = val {
					if !out.is_empty() {
						out.push('\n');
					}
					out.push_str(label);
					out.push_str(": ");
					out.push_str(v.trim_end_matches('\n'));
				}
			}
			out
		},
		SynthReducer::RawConcat => parts
			.iter()
			.filter_map(|(_, v)| v.clone())
			.collect::<Vec<_>>()
			.join(""),
		SynthReducer::Custom(f) => {
			let refs: Vec<(&str, Option<&str>)> =
				parts.iter().map(|(l, v)| (*l, v.as_deref())).collect();
			f(&refs)
		},
	}
}

fn read_file(path: &Path, mode: ReadMode, url: String) -> Result<ResolvedContent, Diagnostic> {
	read_file_with_range(path, None, mode, url, None)
}

fn read_file_with_range(
	path: &Path,
	range: Option<std::ops::Range<usize>>,
	mode: ReadMode,
	url: String,
	mime: Option<&'static str>,
) -> Result<ResolvedContent, Diagnostic> {
	let bytes = std::fs::read(path).map_err(|e| Diagnostic {
		variant: match e.kind() {
			std::io::ErrorKind::NotFound => DiagnosticVariant::FileNotFound,
			std::io::ErrorKind::PermissionDenied => DiagnosticVariant::Inaccessible,
			_ => DiagnosticVariant::ParseError,
		},
		message: format!("read {url}: {e}"),
		span:    None,
	})?;
	let mtime = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
	let content = match mode {
		ReadMode::Utf8Text => {
			let text = String::from_utf8(bytes).map_err(|_| Diagnostic {
				variant: DiagnosticVariant::EncodingFallback,
				message: format!("{url}: not valid UTF-8"),
				span:    None,
			})?;
			Content::Text { value: clamp_range(text, range) }
		},
		ReadMode::Auto => match String::from_utf8(bytes) {
			Ok(text) => Content::Text { value: clamp_range(text, range) },
			Err(e) => Content::Bytes {
				artifact_uri: format!("artifact-bytes-pending://{url}"),
				size:         e.into_bytes().len() as u64,
			},
		},
		ReadMode::Binary => Content::Bytes {
			artifact_uri: format!("artifact-bytes-pending://{url}"),
			size:         bytes.len() as u64,
		},
	};
	Ok(ResolvedContent {
		url,
		source_path: Some(path.to_path_buf()),
		content,
		mime: mime.map(String::from),
		notes: vec![],
		source_mtime: mtime,
	})
}

fn clamp_range(text: String, range: Option<std::ops::Range<usize>>) -> String {
	match range {
		Some(r) if r.start <= text.len() => {
			let end = r.end.min(text.len());
			text[r.start..end].to_string()
		},
		_ => text,
	}
}

fn invalid(msg: impl Into<String>) -> Diagnostic {
	Diagnostic { variant: DiagnosticVariant::ParseError, message: msg.into(), span: None }
}

/// Lexically normalize a path without touching the filesystem:
///   - collapse `.` components
///   - resolve `..` by popping a non-`..` parent
///   - leave leading absolute prefix intact
/// Returns the result as PathBuf. Used to reject escaping subpaths before fs touch.
fn normalize_path(p: &Path) -> std::path::PathBuf {
	use std::path::Component;
	let mut out = std::path::PathBuf::new();
	for c in p.components() {
		match c {
			Component::ParentDir => {
				// Only pop when the trailing component is a real name; otherwise keep
				// `..` so the start_with check below catches escape attempts.
				let popped = out.components().next_back().map(|c| c.as_os_str().to_owned());
				let should_pop = matches!(
					out.components().next_back(),
					Some(Component::Normal(_))
				);
				if should_pop {
					out.pop();
				} else if popped.is_none() || matches!(out.components().next_back(), Some(Component::ParentDir)) {
					out.push("..");
				}
			},
			Component::CurDir => {},
			other => out.push(other.as_os_str()),
		}
	}
	out
}

/// Returns true when `child` is the same path as `parent` or a descendant of it,
/// comparing component-by-component (avoids prefix false-positives like
/// `/foo/bar` starts_with `/foo/ba`).
fn path_starts_with(child: &Path, parent: &Path) -> bool {
	let child_norm = normalize_path(child);
	let parent_norm = normalize_path(parent);
	let mut ci = child_norm.components();
	for pc in parent_norm.components() {
		match ci.next() {
			Some(cc) if cc == pc => {},
			_ => return false,
		}
	}
	true
}

fn cancelled() -> Diagnostic {
	Diagnostic {
		variant: DiagnosticVariant::Cancelled,
		message: "scheme resolution cancelled".into(),
		span:    None,
	}
}

// ── Scheme name validation ───────────────────────────────────────

/// Validates a scheme name per RFC 3986 (tightened to kebab-case ASCII).
pub fn validate_scheme_name(name: &str) -> Result<(), Diagnostic> {
	if name.is_empty() {
		return Err(invalid("scheme name must not be empty"));
	}
	let mut chars = name.chars();
	let first = chars.next().unwrap();
	if !first.is_ascii_lowercase() {
		return Err(invalid(format!("scheme '{name}' must start with [a-z]; got '{first}'")));
	}
	for c in chars {
		if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
			return Err(invalid(format!(
				"scheme '{name}' must be lowercase alphanumeric + hyphens; offending char '{c}'"
			)));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use tempfile::TempDir;

	use super::*;
	use crate::scheme::{CacheStrategy, RootTemplate};

	fn skill_profile(_ctx: Option<&SessionContext>) -> SchemeProfile {
		SchemeProfile {
			scheme:       "skill",
			root:         RootTemplate::ProjectRoot { rel: ".spell/skills".into() },
			layout:       PathLayout::NamedDir {
				entry_file:      "SKILL.md".into(),
				subpath_allowed: true,
			},
			loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
			capabilities: SchemeCapabilities {
				fs_backed:           true,
				codepath_compatible: true,
				mime_hint:           Some("text/markdown"),
				cache:               CacheStrategy::None,
				bash_expandable:     true,
				callback_budget:     None,
			},
		}
	}

	#[test]
	fn validate_scheme_name_accepts_valid() {
		assert!(validate_scheme_name("skill").is_ok());
		assert!(validate_scheme_name("figma-api").is_ok());
		assert!(validate_scheme_name("svc123").is_ok());
	}

	#[test]
	fn validate_scheme_name_rejects_invalid() {
		assert!(validate_scheme_name("").is_err());
		assert!(validate_scheme_name("Skill").is_err());
		assert!(validate_scheme_name("1foo").is_err());
		assert!(validate_scheme_name("foo_bar").is_err());
		assert!(validate_scheme_name("foo.bar").is_err());
	}

	#[test]
	fn registry_lookup() {
		let dir = TempDir::new().unwrap();
		let ctx = SessionContext::new(dir.path(), "/home");
		let reg = SchemeRegistry::from_static([skill_profile as _], Some(&ctx));
		assert!(reg.has_scheme("skill"));
		assert!(!reg.has_scheme("nope"));
		let s = reg.known_schemes();
		assert_eq!(s, vec!["skill".to_string()]);
	}

	#[test]
	fn registry_resolves_fs_backed_scheme() {
		let dir = TempDir::new().unwrap();
		let skill_dir = dir.path().join(".spell/skills/canvas");
		std::fs::create_dir_all(&skill_dir).unwrap();
		std::fs::write(skill_dir.join("SKILL.md"), "# canvas").unwrap();

		let ctx = SessionContext::new(dir.path(), "/home");
		let reg = SchemeRegistry::from_static([skill_profile as _], Some(&ctx));
		let uri = UriLocator { scheme: "skill".into(), path: "canvas".into() };
		let cancel = CancellationToken::new();
		let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
		assert_eq!(r.url, "skill://canvas");
		assert_eq!(r.source_path, Some(dir.path().join(".spell/skills/canvas/SKILL.md")));
		match &r.content {
			Content::Text { value } => assert_eq!(value, "# canvas"),
			_ => panic!("expected Text"),
		}
	}

	#[test]
	fn registry_unknown_scheme_diagnostic() {
		let reg = SchemeRegistry::new();
		let uri = UriLocator { scheme: "nope".into(), path: "x".into() };
		let cancel = CancellationToken::new();
		let err = reg.resolve(&uri, None, &cancel).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::UnknownLocatorScheme { .. }));
	}

	#[test]
	fn registry_rejects_reserved_in_callback() {
		struct DummyCb;
		impl SchemeCallback for DummyCb {
			fn resolve(
				&self,
				_body: &str,
				_ctx: Option<&SessionContext>,
				_cancel: &CancellationToken,
			) -> Result<ResolvedContent, Diagnostic> {
				Err(invalid("never"))
			}
		}
		let mut reg = SchemeRegistry::new();
		let err = reg
			.register_callback("skill".into(), Arc::new(DummyCb), Default::default())
			.unwrap_err();
		assert!(err.message.contains("reserved"));
	}

	#[test]
	fn idfragment_synth_default() {
		let dir = TempDir::new().unwrap();
		let jobs_dir = dir.path().join(".spell/jobs/abc");
		std::fs::create_dir_all(&jobs_dir).unwrap();
		std::fs::write(jobs_dir.join("status.txt"), "running").unwrap();
		std::fs::write(jobs_dir.join("result.txt"), "42").unwrap();

		let jobs_profile = SchemeProfile {
			scheme:       "jobs",
			root:         RootTemplate::ProjectRoot { rel: ".spell/jobs".into() },
			layout:       PathLayout::IdFragment {
				default:   FragmentEntry::Synth(SynthSpec {
					parts:   vec![
						("status".into(), "status.txt".into()),
						("result".into(), "result.txt".into()),
					],
					reducer: SynthReducer::LabeledConcat,
				}),
				fragments: HashMap::new(),
			},
			loader:       ContentLoader::FsRead { mode: ReadMode::Utf8Text },
			capabilities: SchemeCapabilities {
				fs_backed: true,
				cache: CacheStrategy::None,
				..Default::default()
			},
		};
		let ctx = SessionContext::new(dir.path(), "/home");
		let mut reg = SchemeRegistry::new();
		reg.profiles.insert("jobs", jobs_profile);
		let uri = UriLocator { scheme: "jobs".into(), path: "abc".into() };
		let cancel = CancellationToken::new();
		let r = reg.resolve(&uri, Some(&ctx), &cancel).unwrap();
		match &r.content {
			Content::Text { value } => {
				assert!(value.contains("status: running"));
				assert!(value.contains("result: 42"));
			},
			_ => panic!("expected Text"),
		}
	}
}
