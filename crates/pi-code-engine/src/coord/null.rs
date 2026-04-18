use std::path::Path;

use super::client::{CommitResult, CoordClient, IntentResult, PeerEdit, PeerState};

#[derive(Debug, Clone, Default)]
pub struct NullCoordClient;

impl CoordClient for NullCoordClient {
	fn on_open(&self, _: &str, _: &Path, _: u64) {}

	fn intent(&self, _: &str, _: &Path, _: &[String], _: u64) -> IntentResult {
		IntentResult::Granted
	}

	fn commit(
		&self,
		_: &str,
		_: &Path,
		_: u64,
		_: u64,
		_: &[String],
		_: &str,
		_: u64,
	) -> CommitResult {
		CommitResult::Ok
	}

	fn recent_peer_edits(&self, _: &Path, _: u64, _: usize) -> Vec<PeerEdit> {
		Vec::new()
	}

	fn peer_state(&self, _: &Path) -> PeerState {
		PeerState { peers: vec![], recent_commits: vec![], latest_revision: None }
	}

	fn on_close(&self, _: &str, _: &Path) {}
}
