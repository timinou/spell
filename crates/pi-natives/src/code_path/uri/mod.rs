//! URI scheme profile modules.
//!
//! Each scheme is a single-file module exposing
//! `pub fn build(ctx: Option<&SessionContext>) -> SchemeProfile`. The
//! `build.rs` script in this crate scans this directory and emits
//! `SCHEME_FACTORIES`, a static slice of those `build` functions, plus the
//! `pub mod <name>;` declarations needed to compile them.
//!
//! Adding a new scheme = one new `.rs` file. No registration wall.
//!
//! See PLAN-310 for the design; see `pi_code_path::scheme` for the DSL types.

// `scheme_factories.rs` declares `pub mod <name>;` for each scheme file in
// this directory and assembles `SCHEME_FACTORIES`.
include!(concat!(env!("OUT_DIR"), "/scheme_factories.rs"));
