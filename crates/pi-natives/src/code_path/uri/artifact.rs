//! `artifact://<session-id>/<agent>/<tool>/<filename>` →
//!   `<home>/.spell/agent/sessions/<project>/<dir>_<session-id>/<agent>/<tool>/<filename>`
//!
//! PLAN-310 BUG-396: declarative profile with mtime-cached cross-session
//! index. Mirrors the TS `ArtifactProtocolHandler::findSessionArtifactRoot`
//! 2-level scan but stays in the kernel (no JS callback round-trip).
//!
//! Layout: PathLayout::Indexed + ContentLoader::Indexed { lookup }.
//! The lookup parses body as `<session-id>/<agent>/<tool>/<filename>`,
//! consults a regex-suffix index on the sessions root, and emits a
//! ResolvedAddress with optional "Binary artifact" note for known
//! image/pdf extensions.

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, RwLock},
	time::SystemTime,
};

use pi_code_path::{
	CacheStrategy, ContentLoader, IndexLookup, PathLayout, ResolvedAddress, RootTemplate,
	SchemeCapabilities, SchemeProfile, SessionContext,
	resolver::traits::CancellationToken,
	types::{Diagnostic, DiagnosticVariant},
};
use regex::Regex;

/// Session-dir-name suffix regex — mirrors TS
/// `packages/coding-agent/src/session/artifacts.ts::SESSION_ROOT_NAME_RE`.
///
/// Captures the hex session id from a dir name like `mywork_abc123def`.
fn session_suffix_re() -> &'static Regex {
	use std::sync::OnceLock;
	static RE: OnceLock<Regex> = OnceLock::new();
	RE.get_or_init(|| Regex::new(r"_([0-9a-f]+)$").expect("static regex"))
}

const BINARY_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "pdf"];

#[derive(Default)]
struct ArtifactIndex {
	/// `(combined-mtime, session-id → session-dir-path)`
	cache: RwLock<Option<(SystemTime, HashMap<String, PathBuf>)>>,
}

impl ArtifactIndex {
	fn sessions_root(ctx: Option<&SessionContext>) -> Result<PathBuf, Diagnostic> {
		let ctx = ctx.ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "artifact:// requires SessionContext".into(),
			span:    None,
		})?;
		Ok(ctx.home.join(".spell/agent/sessions"))
	}

	/// Compute a combined mtime across all project sub-dirs of the sessions
	/// root. Any new project or new session dir inside a project bumps the
	/// combined mtime and triggers index rebuild.
	fn combined_mtime(root: &std::path::Path) -> SystemTime {
		let mut latest = SystemTime::UNIX_EPOCH;
		let root_mtime = std::fs::metadata(root)
			.and_then(|m| m.modified())
			.unwrap_or(SystemTime::UNIX_EPOCH);
		if root_mtime > latest {
			latest = root_mtime;
		}
		let Ok(projects) = std::fs::read_dir(root) else { return latest };
		for proj in projects.flatten() {
			if let Ok(meta) = proj.metadata() {
				if let Ok(m) = meta.modified() {
					if m > latest {
						latest = m;
					}
				}
			}
		}
		latest
	}

	fn build_index(root: &std::path::Path) -> HashMap<String, PathBuf> {
		let mut idx = HashMap::new();
		let Ok(projects) = std::fs::read_dir(root) else { return idx };
		let re = session_suffix_re();
		for proj in projects.flatten() {
			if !proj.path().is_dir() {
				continue;
			}
			let Ok(sessions) = std::fs::read_dir(proj.path()) else { continue };
			for session in sessions.flatten() {
				if !session.path().is_dir() {
					continue;
				}
				let name = session.file_name().to_string_lossy().into_owned();
				if let Some(cap) = re.captures(&name) {
					let id = cap.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
					if !id.is_empty() {
						// First-wins: if two project dirs claim the same id (shouldn't
						// happen), keep the lexically smaller path for determinism.
						idx.entry(id).or_insert_with(|| session.path());
					}
				}
			}
		}
		idx
	}

	fn session_for(
		&self,
		session_id: &str,
		ctx: Option<&SessionContext>,
	) -> Result<PathBuf, Diagnostic> {
		let root = Self::sessions_root(ctx)?;
		let current_mtime = Self::combined_mtime(&root);

		// Fast path: reuse cache if mtime unchanged.
		{
			let cached = self.cache.read().expect("artifact index lock poisoned");
			if let Some((m, idx)) = cached.as_ref() {
				if *m == current_mtime {
					return idx.get(&session_id.to_lowercase()).cloned().ok_or_else(|| {
						Diagnostic {
							variant: DiagnosticVariant::FileNotFound,
							message: format!("artifact session not found: {session_id}"),
							span:    None,
						}
					});
				}
			}
		}

		// Slow path: rebuild the entire index from scratch.
		let idx = Self::build_index(&root);
		let result = idx.get(&session_id.to_lowercase()).cloned();
		*self.cache.write().expect("artifact index lock poisoned") = Some((current_mtime, idx));
		result.ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::FileNotFound,
			message: format!("artifact session not found: {session_id}"),
			span:    None,
		})
	}
}

impl IndexLookup for ArtifactIndex {
	fn lookup(
		&self,
		body: &str,
		ctx: Option<&SessionContext>,
		_cancel: &CancellationToken,
	) -> Result<ResolvedAddress, Diagnostic> {
		// Parse <session-id>/<agent>/<tool>/<filename>.
		let mut parts = body.splitn(4, '/');
		let session_id = parts.next().filter(|s| !s.is_empty()).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "body must be '<session-id>/<agent>/<tool>/<filename>'".into(),
			span:    None,
		})?;
		let agent = parts.next().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "body must be '<session-id>/<agent>/<tool>/<filename>'".into(),
			span:    None,
		})?;
		let tool = parts.next().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "body must be '<session-id>/<agent>/<tool>/<filename>'".into(),
			span:    None,
		})?;
		let filename = parts.next().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "body must be '<session-id>/<agent>/<tool>/<filename>'".into(),
			span:    None,
		})?;

		let session_dir = self.session_for(session_id, ctx)?;
		let path = session_dir.join(agent).join(tool).join(filename);

		let mut notes = Vec::new();
		let ext = std::path::Path::new(filename)
			.extension()
			.and_then(|e| e.to_str())
			.unwrap_or("")
			.to_lowercase();
		if BINARY_EXTENSIONS.iter().any(|e| *e == ext) {
			notes.push(format!(
				"Binary artifact ({ext}). Use sourcePath-aware tools to inspect it."
			));
		}

		Ok(ResolvedAddress { path, range: None, notes })
	}
}

pub fn build(_ctx: Option<&SessionContext>) -> SchemeProfile {
	SchemeProfile {
		scheme:       "artifact",
		usage:        "artifact://<session-id>/<agent>/<tool>/<n>.<ext>",
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Indexed,
		loader:       ContentLoader::Indexed {
			lookup:    Arc::new(ArtifactIndex::default()),
			read_mode: pi_code_path::ReadMode::Auto,
		},
		capabilities: SchemeCapabilities {
			fs_backed:           true,
			codepath_compatible: true,
			mime_hint:           None,
			cache:               CacheStrategy::UntilMtimeChange,
			bash_expandable:     true,
			callback_budget:     None,
			static_notes:        &[],
		},
	}
}
