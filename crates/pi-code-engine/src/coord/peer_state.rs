use std::{
	collections::{HashMap, VecDeque},
	path::{Path, PathBuf},
};

use parking_lot::Mutex;

use super::client::{PeerEdit, PeerInfo, PeerState};

const RECENT_LIMIT: usize = 64;

#[derive(Debug, Default)]
pub struct PeerStateStore {
	peers:           Mutex<Vec<PeerInfo>>,
	recent:          Mutex<HashMap<PathBuf, VecDeque<PeerEdit>>>,
	latest_revision: Mutex<HashMap<PathBuf, u64>>,
}

impl PeerStateStore {
	pub fn replace_peers(&self, peers: Vec<PeerInfo>) {
		*self.peers.lock() = peers;
	}

	pub fn replace_recent(&self, file: &Path, edits: Vec<PeerEdit>) {
		let key = file.to_path_buf();
		let latest_revision = edits.first().map_or(0, |edit| edit.revision);
		let mut queue = VecDeque::with_capacity(edits.len().min(RECENT_LIMIT));
		queue.extend(edits.into_iter().take(RECENT_LIMIT));
		self.recent.lock().insert(key.clone(), queue);
		if latest_revision == 0 {
			self.latest_revision.lock().remove(&key);
		} else {
			self.latest_revision.lock().insert(key, latest_revision);
		}
	}

	pub fn record_commit(&self, file: &Path, edit: PeerEdit) {
		let key = file.to_path_buf();
		let latest = edit.revision;
		let mut recent = self.recent.lock();
		let queue = recent.entry(key.clone()).or_default();
		queue.push_front(edit);
		while queue.len() > RECENT_LIMIT {
			queue.pop_back();
		}
		self.latest_revision.lock().insert(key, latest);
	}

	pub fn recent_peer_edits(&self, file: &Path, since_ms: u64, limit: usize) -> Vec<PeerEdit> {
		let key = file.to_path_buf();
		let recent = self.recent.lock();
		recent
			.get(&key)
			.map(|entries| {
				entries
					.iter()
					.filter(|edit| edit.ts >= since_ms)
					.take(limit)
					.cloned()
					.collect()
			})
			.unwrap_or_default()
	}

	pub fn peer_state(&self, file: &Path) -> PeerState {
		let key = file.to_path_buf();
		PeerState {
			peers:           self.peers.lock().clone(),
			recent_commits:  self.recent_peer_edits(file, 0, RECENT_LIMIT),
			latest_revision: self.latest_revision.lock().get(&key).copied(),
		}
	}
}
