//! `pi-edit-broker` — in-process library counterpart of the `pi-edit-broker`
//! daemon binary.
//!
//! The daemon is a thin CLI wrapper around the `server` module; callers in
//! `pi-code-engine` reuse `protocol` types and `spawn_broker_if_absent` via
//! this library.

pub mod conn;
pub mod error;
pub mod protocol;
pub mod reaper;
pub mod server;
pub mod spawn;
pub mod state;

pub use error::{BrokerError, Result};
pub use protocol::{ClientMessage, CommitRecord, PeerSummary, ServerMessage, SessionId};
pub use server::{BrokerOptions, run_server};
pub use spawn::{probe, resolve_binary, spawn_broker_if_absent};
