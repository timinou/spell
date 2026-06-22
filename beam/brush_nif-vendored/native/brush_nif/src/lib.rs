//! brush_nif — Rustler NIF exposing brush (a Rust bash) to the BEAM.
//!
//! - `run` / `pipe` (PLAN-011 W0/W4): execute an argv vector / pipeline,
//!   inject-proof, with output capture, timeout, and panic isolation.
//! - `parse` / `unparse` (PLAN-011 W5): bash text <-> a PTC-native `form_tree`
//!   tree, so a shell pipeline and a Lisp program share one recall layer.

mod argv;
mod project;
mod run;

use rustler::{Encoder, Env, NifResult, Term};

mod atoms {
	rustler::atoms! { ok, error }
}

/// Parse a bash string into a PTC-native `form_tree` tree (PLAN-011 W5).
///
/// Returns `{:ok, tree}` for valid bash (exotic constructs degrade to `raw`
/// leaves, never an error) or `{:error, reason}` for a genuine parse error.
#[rustler::nif]
fn parse<'a>(env: Env<'a>, src: String) -> NifResult<Term<'a>> {
	let result = std::panic::catch_unwind(|| project::parse(&src));
	match result {
		Ok(Ok(node)) => Ok((atoms::ok(), node.encode(env)).encode(env)),
		Ok(Err(reason)) => Ok((atoms::error(), reason).encode(env)),
		Err(_) => Ok((atoms::error(), "panic during parse").encode(env)),
	}
}

/// Render a `form_tree`-shaped tree back into a bash string (PLAN-011 W5).
///
/// Words are re-escaped so a round-trip can never reintroduce shell injection.
/// Returns `{:ok, bash}` or `{:error, reason}` on a panic.
#[rustler::nif]
fn unparse<'a>(env: Env<'a>, tree: Term<'a>) -> NifResult<Term<'a>> {
	let node = project::UnparseNode::decode(tree);
	let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| project::unparse(&node)));
	match result {
		Ok(bash) => Ok((atoms::ok(), bash).encode(env)),
		Err(_) => Ok((atoms::error(), "panic during unparse").encode(env)),
	}
}

rustler::init!("Elixir.SpellAgent.BrushNif");
