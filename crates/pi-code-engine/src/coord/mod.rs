pub mod client;
pub mod journal;
pub mod node_ref;
pub mod null;
pub mod peer_state;
pub mod socket;

pub use client::{
	CommitResult, CoordClient, IntentResult, PeerEdit, PeerInfo, PeerState, SessionId,
};
pub use journal::{
	JournalEntry, JournalReader, JournalWriter, default_journal_root, journal_path_for,
};
pub use node_ref::derive_code_paths;
pub use null::NullCoordClient;
pub use socket::{BrokerEndpoint, SocketCoordClient};

pub(crate) fn blake3_short(bytes: &[u8]) -> String {
	blake3::hash(bytes).to_hex()[..16].to_string()
}
