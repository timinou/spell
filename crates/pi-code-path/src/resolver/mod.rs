//! CodePath resolver module — traits, dispatch, setops, projection.
//!
//! Replaces the legacy single-file `resolver.rs` with a structured
//! submodule tree.

pub mod dispatch;
pub mod projection;
pub mod setops;
pub mod traits;

pub use dispatch::*;
pub use projection::*;
pub use setops::*;
pub use traits::*;
