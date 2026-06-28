//! Rustler NIF skin over `pi_kernel::resolve_target` (PLAN-334 / P3.3b).
//!
//! The BEAM-side analogue of the pi-natives NAPI skin. It calls the SAME
//! host-agnostic kernel entry the NAPI read branch calls, so the read result is
//! byte-identical across runtimes (gate 1). The kernel resolves fully in Rust;
//! the NIF returns an owned JSON string to the BEAM, so no `tree_sitter::Node`
//! borrow escapes the call.
//!
//! Panic-safety (gate 2 groundwork): every NIF entry wraps the kernel call in
//! `std::panic::catch_unwind`. A NIF panic would otherwise abort the WHOLE BEAM
//! node (unlike a NAPI panic, which kills only one Node process). A caught
//! panic is returned to the BEAM as `{:error, reason}` and the node survives.

mod broker_conn;
mod code_tree;

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	path::Path,
	sync::{Arc, OnceLock},
};

use pi_code_engine::{
	buffer::BufferRegistry,
	coord::{BrokerEndpoint, SocketCoordClient},
	language::LanguageRegistry,
};
use pi_code_path::resolver::CancellationToken;

/// The warm language registry — built once per BEAM node and shared across all
/// resolve calls (the "warm kernel": pay the registry init cost once, not per
/// query). Read-only after init; `LanguageRegistry` is `Send + Sync`.
fn registry() -> &'static Arc<LanguageRegistry> {
	static REGISTRY: OnceLock<Arc<LanguageRegistry>> = OnceLock::new();
	REGISTRY.get_or_init(|| {
		Arc::new(LanguageRegistry::with_builtins().expect("kernel language registry init failed"))
	})
}

/// Resolve a read `target` rooted at `root`, returning a JSON object string
/// `{"nodes": [...], "diagnostics": [...]}` on success, or `{:error, reason}`.
///
/// Mirrors the NAPI read path via the shared `pi_kernel::resolve_target`. A
/// test flag `__panic__` in the target forces a panic to exercise gate-2
/// (P3.4).
#[rustler::nif(schedule = "DirtyCpu")]
fn resolve_target(target: String, root: String) -> Result<String, String> {
	// `catch_unwind` is the gate-2 guard: a panic anywhere in the kernel resolve
	// is caught here and returned as an error, never unwinding into the BEAM.
	let outcome = catch_unwind(AssertUnwindSafe(|| {
		// Test-only fault injection (gate 2): a target ending in the sentinel
		// panics inside the NIF boundary. Real targets never contain it.
		if target.ends_with("::__panic__") {
			panic!("injected NIF panic for gate-2 test: {target}");
		}
		let cancel = CancellationToken::new();
		// gitignore defaults to the resolver default (None) for the NIF read lane.
		pi_kernel::resolve_target(registry(), &target, Path::new(&root), &[], None, &cancel)
	}));

	match outcome {
		Ok(Ok(out)) => {
			let value = serde_json::json!({
				"nodes": out.nodes,
				"diagnostics": out.diagnostics,
			});
			serde_json::to_string(&value).map_err(|e| format!("serialize error: {e}"))
		},
		Ok(Err(diag)) => Err(format!("{:?}: {}", diag.variant, diag.message)),
		Err(panic) => {
			let reason = panic
				.downcast_ref::<&str>()
				.map(|s| s.to_string())
				.or_else(|| panic.downcast_ref::<String>().cloned())
				.unwrap_or_else(|| "unknown panic".to_string());
			Err(format!("panic caught in NIF: {reason}"))
		},
	}
}

/// The warm BEAM-side buffer registry — one per node, wired to the broker as
/// the `beam` peer so cross-runtime edit coordination (intents, peer-conflict
/// detection, journal) is shared with the NAPI `napi` peer through the SAME
/// broker. Built once; `BufferRegistry` is `Send + Sync` (P5.B / PLAN-336).
fn buffers() -> &'static BufferRegistry {
	static BUFFERS: OnceLock<BufferRegistry> = OnceLock::new();
	BUFFERS.get_or_init(|| {
		let endpoint = BrokerEndpoint::default_for("beam".into());
		BufferRegistry::new_with_coord(
			registry().clone(),
			None,
			Arc::new(SocketCoordClient::new(endpoint)),
		)
	})
}

/// Apply ONE edit `action` (JSON string) to `target` (`<file>` or
/// `<file>::<symbol>`), attributed to `session_id` ("" = no session). Returns
/// `{"edit_count":N,"revision":R,"targetSummary":"…"}` JSON. Writes commit
/// through the warm registry's transaction, coordinated cross-runtime via the
/// broker (P5.B). catch_unwind-wrapped (gate 2): a panic is `{:error, _}`, node
/// survives.
#[rustler::nif(schedule = "DirtyIo")]
fn apply_edit(session_id: String, target: String, action_json: String) -> Result<String, String> {
	let outcome = catch_unwind(AssertUnwindSafe(|| {
		let action: serde_json::Value =
			serde_json::from_str(&action_json).map_err(|e| format!("invalid action JSON: {e}"))?;
		// target = `<file>` or `<file>::<symbol>`; the file part is the path.
		let file_part = target.split_once("::").map_or(target.as_str(), |(f, _)| f);
		let path = Path::new(file_part).to_path_buf();
		let sid = if session_id.is_empty() {
			None
		} else {
			Some(session_id.as_str())
		};
		pi_kernel::apply_edit(registry(), buffers(), sid, &path, &target, &action)
			.map_err(|d| format!("{d}"))
	}));

	match outcome {
		Ok(Ok(out)) => {
			let value = serde_json::json!({
				"edit_count": out.edit_count,
				"revision": out.revision,
				"targetSummary": out.target_summary,
			});
			serde_json::to_string(&value).map_err(|e| format!("serialize error: {e}"))
		},
		Ok(Err(reason)) => Err(reason),
		Err(panic) => {
			let reason = panic
				.downcast_ref::<&str>()
				.map(|s| s.to_string())
				.or_else(|| panic.downcast_ref::<String>().cloned())
				.unwrap_or_else(|| "unknown panic".to_string());
			Err(format!("panic caught in NIF: {reason}"))
		},
	}
}

/// Resolve a graph-edge `target` (one containing
/// `def→/ref→/call→/import→/bind→`) rooted at `root`, returning `{"nodes":
/// [...], "diagnostics": [...]}` JSON. This serves edges from the SAME warm
/// resident `pi-kernel` index the NAPI skin uses — one index per BEAM node,
/// shared across N agents (P5.A, PLAN-336 / WS-B).
///
/// Like `resolve_target`, the kernel call is `catch_unwind`-wrapped (gate 2): a
/// panic surfaces as `{:error, reason}` and the node survives.
#[rustler::nif(schedule = "DirtyCpu")]
fn resolve_edges(target: String, root: String) -> Result<String, String> {
	let outcome = catch_unwind(AssertUnwindSafe(|| {
		let cancel = CancellationToken::new();
		pi_kernel::resolve_edges(registry(), &target, Path::new(&root), &cancel)
	}));

	match outcome {
		Ok(Ok(out)) => {
			let value = serde_json::json!({
				"nodes": out.nodes,
				"diagnostics": out.diagnostics,
			});
			serde_json::to_string(&value).map_err(|e| format!("serialize error: {e}"))
		},
		Ok(Err(diag)) => Err(format!("{:?}: {}", diag.variant, diag.message)),
		Err(panic) => {
			let reason = panic
				.downcast_ref::<&str>()
				.map(|s| s.to_string())
				.or_else(|| panic.downcast_ref::<String>().cloned())
				.unwrap_or_else(|| "unknown panic".to_string());
			Err(format!("panic caught in NIF: {reason}"))
		},
	}
}

/// Liveness probe — returns `:ok`. Used by the gate-2 test to confirm the BEAM
/// node is still alive AFTER a caught NIF panic.
#[rustler::nif]
fn ping() -> rustler::Atom {
	rustler::types::atom::ok()
}

/// Parse `src` (a source string in language `lang`) into a `form_tree` JSON
/// string — the canonical walkable shape the q/* algebra runs on (PLAN-020 W3).
///
/// `lang` is a language id (`"elixir"`, `"rust"`, `"typescript"`, ...). The
/// warm language registry supplies the tree-sitter grammar. Returns the
/// form_tree as an owned JSON string (no `tree_sitter::Node` borrow escapes the
/// call, exactly like `resolve_target`). A genuine parse failure is `{:error,
/// reason}`; valid source with ERROR nodes still succeeds (errors become `raw`
/// leaves).
#[rustler::nif(schedule = "DirtyCpu")]
fn parse_code(src: String, lang: String) -> Result<String, String> {
	let outcome = catch_unwind(AssertUnwindSafe(|| {
		let id = pi_code_engine::language::LanguageId::new(lang.clone());
		let profile = registry()
			.get(&id)
			.ok_or_else(|| format!("unknown language: {lang}"))?;
		let tree = code_tree::parse_to_form_tree(&profile.ts_language, &src)?;
		serde_json::to_string(&tree).map_err(|e| format!("serialize error: {e}"))
	}));

	match outcome {
		Ok(result) => result,
		Err(panic) => Err(format!("panic caught in NIF: {}", panic_reason(panic))),
	}
}

/// Render a `form_tree` JSON string back to a source string (PLAN-020 W3).
///
/// The inverse of `parse_code`: an untouched node round-trips byte-exactly (it
/// still carries its verbatim `text`); an edited node rejoins its children
/// (presentation canonicalizes — the re-parse-equality contract, not byte
/// equality). Returns `{:error, reason}` on malformed JSON input.
#[rustler::nif(schedule = "DirtyCpu")]
fn unparse_code(tree_json: String) -> Result<String, String> {
	let outcome = catch_unwind(AssertUnwindSafe(|| {
		let tree: serde_json::Value =
			serde_json::from_str(&tree_json).map_err(|e| format!("invalid form_tree JSON: {e}"))?;
		Ok::<String, String>(code_tree::unparse_form_tree(&tree))
	}));

	match outcome {
		Ok(result) => result,
		Err(panic) => Err(format!("panic caught in NIF: {}", panic_reason(panic))),
	}
}

/// Extract a readable reason from a caught panic payload.
fn panic_reason(panic: Box<dyn std::any::Any + Send>) -> String {
	panic
		.downcast_ref::<&str>()
		.map(|s| s.to_string())
		.or_else(|| panic.downcast_ref::<String>().cloned())
		.unwrap_or_else(|| "unknown panic".to_string())
}

rustler::init!("Elixir.PiKernelNif");

// NB: `broker_conn`'s NIFs (claim_intent/release_intent) and the
// BrokerConnection resource are registered via their #[rustler::nif] /
// #[rustler::resource_impl] attributes + auto-discovery (rustler 0.38).
