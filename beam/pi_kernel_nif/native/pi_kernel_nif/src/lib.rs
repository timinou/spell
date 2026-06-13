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
//! node (unlike a NAPI panic, which kills only one Node process). A caught panic
//! is returned to the BEAM as `{:error, reason}` and the node survives.

mod broker_conn;

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	path::Path,
	sync::{Arc, OnceLock},
};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::resolver::CancellationToken;

/// The warm language registry — built once per BEAM node and shared across all
/// resolve calls (the "warm kernel": pay the registry init cost once, not per
/// query). Read-only after init; `LanguageRegistry` is `Send + Sync`.
fn registry() -> &'static Arc<LanguageRegistry> {
	static REGISTRY: OnceLock<Arc<LanguageRegistry>> = OnceLock::new();
	REGISTRY.get_or_init(|| {
		Arc::new(
			LanguageRegistry::with_builtins().expect("kernel language registry init failed"),
		)
	})
}

/// Resolve a read `target` rooted at `root`, returning a JSON object string
/// `{"nodes": [...], "diagnostics": [...]}` on success, or `{:error, reason}`.
///
/// Mirrors the NAPI read path via the shared `pi_kernel::resolve_target`. A test
/// flag `__panic__` in the target forces a panic to exercise gate-2 (P3.4).
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

/// Liveness probe — returns `:ok`. Used by the gate-2 test to confirm the BEAM
/// node is still alive AFTER a caught NIF panic.
#[rustler::nif]
fn ping() -> rustler::Atom {
	rustler::types::atom::ok()
}

rustler::init!("Elixir.PiKernelNif");

// NB: `broker_conn`'s NIFs (claim_intent/release_intent) and the
// BrokerConnection resource are registered via their #[rustler::nif] /
// #[rustler::resource_impl] attributes + auto-discovery (rustler 0.38).
