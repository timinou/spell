pub mod client;
pub mod journal;
pub mod node_ref;
pub mod null;

pub use client::{
	CommitResult, CoordClient, IntentResult, PeerEdit, PeerInfo, PeerState, SessionId,
};
pub use journal::{
	JournalEntry, JournalReader, JournalWriter, default_journal_root, journal_path_for,
};
pub use node_ref::derive_code_paths;
pub use null::NullCoordClient;

/// Short blake3 digest (first 16 hex chars). Used for stable journal path
/// keys; NOT a security primitive.
pub(crate) fn blake3_short(bytes: &[u8]) -> String {
	let hash = blake3::hash(bytes);
	hash.to_hex().as_str()[..16].to_string()
}
