pub mod client;
pub mod journal;
pub mod node_ref;
pub mod null;
pub mod peer_state;
pub mod socket;

pub use client::{
	CommitResult, CoordClient, IntentResult, OwnerId, PeerEdit, PeerInfo, PeerState, SessionId,
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

#[cfg(test)]
pub struct MockCoordClient {
	intent_called: std::sync::atomic::AtomicBool,
	commit_called: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MockCoordClient {
	pub fn new() -> Self {
		Self {
			intent_called: std::sync::atomic::AtomicBool::new(false),
			commit_called: std::sync::atomic::AtomicBool::new(false),
		}
	}

	pub fn intent_called(&self) -> bool {
		self.intent_called.load(std::sync::atomic::Ordering::SeqCst)
	}

	pub fn commit_called(&self) -> bool {
		self.commit_called.load(std::sync::atomic::Ordering::SeqCst)
	}
}

#[cfg(test)]
impl CoordClient for MockCoordClient {
	fn on_open(&self, _owner: &OwnerId, _file: &std::path::Path, _revision: u64) {}

	fn intent(
		&self,
		_owner: &OwnerId,
		_file: &std::path::Path,
		_code_paths: &[String],
		_base_revision: u64,
	) -> IntentResult {
		self
			.intent_called
			.store(true, std::sync::atomic::Ordering::SeqCst);
		IntentResult::Granted
	}

	fn commit(
		&self,
		_owner: &OwnerId,
		_file: &std::path::Path,
		_revision: u64,
		_parent_revision: u64,
		_code_paths: &[String],
		_diff_hash: &str,
		_byte_len: u64,
	) -> CommitResult {
		self
			.commit_called
			.store(true, std::sync::atomic::Ordering::SeqCst);
		CommitResult::Ok
	}

	fn recent_peer_edits(
		&self,
		_file: &std::path::Path,
		_since_ms: u64,
		_limit: usize,
	) -> Vec<PeerEdit> {
		Vec::new()
	}

	fn peer_state(&self, _file: &std::path::Path) -> PeerState {
		PeerState { peers: Vec::new(), recent_commits: Vec::new(), latest_revision: None }
	}

	fn on_close(&self, _owner: &OwnerId, _file: &std::path::Path) {}
}
