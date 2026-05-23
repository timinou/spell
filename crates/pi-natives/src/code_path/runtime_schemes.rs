//! Process-global runtime scheme registry.
//!
//! Holds callback-backed `SchemeProfile`s registered by TS at session-init
//! (canvas, MCP-advertised). Static profiles (skill, rule, memory, …) come
//! from `pi-natives::code_path::uri::SCHEME_FACTORIES`; this module holds the
//! mutable runtime additions.
//!
//! Per PLAN-310 W2: TS calls `register_scheme_callback(name, tsfn, opts)` for
//! each scheme its session provides. Calls are validated against:
//! - RFC-3986 ASCII-kebab name rules
//! - kernel reserved names (`skill`, `rule`, …)
//! - existing dynamic registrations (no silent overwrite)

use std::{
	collections::HashMap,
	sync::{Arc, Mutex, OnceLock},
	time::Duration,
};

use napi::{Status, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;
use pi_code_path::{
	CacheStrategy, ContentLoader, PathLayout, RootTemplate, SchemeCapabilities, SchemeProfile,
	scheme_dispatch::{RESERVED_SCHEMES, validate_scheme_name},
	types::{Diagnostic, DiagnosticVariant},
};

use crate::code_path::scheme_callback::{JsResolvedContent, JsTsfnCallback};

/// One runtime scheme entry.
struct DynamicEntry {
	profile: SchemeProfile,
}

/// Process-global mutable registry of runtime-registered schemes.
fn registry() -> &'static Mutex<HashMap<String, DynamicEntry>> {
	static REG: OnceLock<Mutex<HashMap<String, DynamicEntry>>> = OnceLock::new();
	REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Snapshot for use by `SchemeRegistry::for_session`. Returns a `Vec<(name,
/// profile)>` — `SchemeRegistry::register_callback` doesn't expose direct
/// profile insertion, so this is consumed by a small adapter below.
pub fn snapshot_dynamic_profiles() -> Vec<(String, SchemeProfile)> {
	registry()
		.lock()
		.expect("runtime scheme registry poisoned")
		.iter()
		.map(|(name, entry)| (name.clone(), entry.profile.clone()))
		.collect()
}

// ── NAPI surface ─────────────────────────────────────────────────

/// JS-visible options when registering a runtime scheme.
#[napi(object)]
pub struct SchemeCallbackOptions {
	/// Treat as fs-backed (codepath suffix forwarding). Default: false.
	pub fs_backed:           Option<bool>,
	/// `<uri>::<codepath-suffix>` supported. Implies `fs_backed`. Default:
	/// false.
	pub codepath_compatible: Option<bool>,
	/// Default MIME type for results.
	pub mime_hint:           Option<String>,
	/// Whether brush should expand this scheme inside bash commands. Default:
	/// false.
	pub bash_expandable:     Option<bool>,
	/// Sync callback budget in ms. Default: 5000.
	pub budget_ms:           Option<u32>,
	/// Canonical URI form shown in error diagnostics. Default: `<scheme>://<body>`.
	/// Pass something like `"rule://<name>"` to give users an exact shape to copy.
	pub usage:               Option<String>,
}

/// Register a runtime URI scheme backed by a JS callback.
///
/// On collision with a reserved scheme name (skill, rule, …) or an existing
/// dynamic registration, the call errors with a clear diagnostic.
#[napi]
pub fn register_scheme_callback(
	scheme: String,
	callback: ThreadsafeFunction<String, JsResolvedContent>,
	options: Option<SchemeCallbackOptions>,
) -> napi::Result<()> {
	validate_scheme_name(&scheme).map_err(diag_to_napi)?;
	if RESERVED_SCHEMES.contains(&scheme.as_str()) {
		return Err(napi::Error::from_reason(format!("scheme '{scheme}' is reserved by the kernel")));
	}
	let mut reg = registry().lock().expect("runtime registry poisoned");
	if reg.contains_key(&scheme) {
		return Err(napi::Error::from_reason(format!(
			"scheme '{scheme}' is already registered; call unregisterSchemeCallback first"
		)));
	}

	let opts = options.unwrap_or(SchemeCallbackOptions {
		fs_backed:           None,
		codepath_compatible: None,
		mime_hint:           None,
		bash_expandable:     None,
		budget_ms:           None,
		usage:               None,
	});
	let budget = Duration::from_millis(opts.budget_ms.unwrap_or(5000) as u64);
	let cb =
		Arc::new(JsTsfnCallback::new(callback, budget)) as Arc<dyn pi_code_path::SchemeCallback>;
	let mime_hint = opts.mime_hint.map(|s| -> &'static str {
		// Leak: mime_hint stays for process lifetime; acceptable for a small set of MCP
		// servers.
		Box::leak(s.into_boxed_str())
	});
	let usage_str = opts.usage.unwrap_or_else(|| format!("{scheme}://<body>"));
	let usage = Box::leak(usage_str.into_boxed_str());
	let profile = SchemeProfile {
		// Box::leak so &'static str outlives the call. One leak per registration.
		scheme:       Box::leak(scheme.clone().into_boxed_str()),
		usage,
		root:         RootTemplate::Virtual,
		layout:       PathLayout::Direct,
		loader:       ContentLoader::Callback(cb),
		capabilities: SchemeCapabilities {
			fs_backed: opts.fs_backed.unwrap_or(false),
			codepath_compatible: opts.codepath_compatible.unwrap_or(false),
			mime_hint,
			cache: CacheStrategy::Ttl(budget),
			bash_expandable: opts.bash_expandable.unwrap_or(false),
			callback_budget: Some(budget),
			static_notes:    &[],
		},
	};
	reg.insert(scheme, DynamicEntry { profile });
	Ok(())
}

/// Unregister a runtime scheme. Returns false if the scheme wasn't registered.
#[napi]
pub fn unregister_scheme_callback(scheme: String) -> bool {
	let mut reg = registry().lock().expect("runtime registry poisoned");
	reg.remove(&scheme).is_some()
}

/// List currently-registered dynamic scheme names. Inspection helper for tests
/// and the diagnostic surface.
#[napi]
pub fn list_registered_schemes() -> Vec<String> {
	let reg = registry().lock().expect("runtime registry poisoned");
	let mut v: Vec<String> = reg.keys().cloned().collect();
	v.sort();
	v
}

/// Reset the runtime registry. Used by tests to isolate state between cases.
#[napi]
pub fn clear_runtime_schemes() {
	registry()
		.lock()
		.expect("runtime registry poisoned")
		.clear();
}

fn diag_to_napi(d: Diagnostic) -> napi::Error {
	napi::Error::from_reason(d.message)
}

#[allow(dead_code)]
fn discriminant(d: &Diagnostic) -> &'static str {
	match d.variant {
		DiagnosticVariant::ParseError => "parse_error",
		DiagnosticVariant::Cancelled => "cancelled",
		_ => "other",
	}
}

/// Build a `SchemeRegistry` for the given session that merges:
/// - static profiles from `pi-natives::code_path::uri::SCHEME_FACTORIES`
/// - dynamic profiles snapshotted from this registry
///
/// Used by `executeCodePath` to dispatch URI locators kernel-side.
pub fn scheme_registry_for_session(
	ctx: Option<&pi_code_path::SessionContext>,
) -> pi_code_path::scheme_dispatch::SchemeRegistry {
	let mut reg = pi_code_path::scheme_dispatch::SchemeRegistry::from_static(
		crate::code_path::uri::SCHEME_FACTORIES.iter().copied(),
		ctx,
	);
	for (_name, profile) in snapshot_dynamic_profiles() {
		// Failure here means a name collision (shouldn't happen after validation);
		// log and skip rather than panic.
		let _ = reg.register_dynamic_profile(profile);
	}
	reg
}
