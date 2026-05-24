use std::{
	path::{Path, PathBuf},
	time::Duration,
};

use pi_edit_broker::{BrokerOptions, ClientMessage, ServerMessage, run_server, state::now_ms};
use tempfile::TempDir;
use tokio::{
	io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf, split},
	net::UnixStream,
	task::JoinHandle,
	time::timeout,
};

#[allow(dead_code, reason = "each test binary only uses a subset of the shared helpers")]
pub struct TestBroker {
	pub socket_path: PathBuf,
	pub _temp:       TempDir,
	handle:          Option<JoinHandle<()>>,
}

#[allow(dead_code, reason = "each test binary only uses a subset of the shared helpers")]
impl TestBroker {
	pub async fn start_with_grace(grace: Duration) -> Self {
		let temp = tempfile::tempdir().expect("tempdir");
		let socket_path = temp.path().join("edit-broker.sock");
		let opts = BrokerOptions {
			socket_path: socket_path.clone(),
			grace,
			broadcast_capacity: 256,
			journal_path: None,
		};
		let handle = tokio::spawn(async move {
			run_server(opts).await.expect("broker exits cleanly");
		});
		// Wait up to 2s for the socket to appear.
		let deadline = std::time::Instant::now() + Duration::from_secs(2);
		while std::time::Instant::now() < deadline {
			if UnixStream::connect(&socket_path).await.is_ok() {
				break;
			}
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		Self { socket_path, _temp: temp, handle: Some(handle) }
	}

	pub async fn start() -> Self {
		Self::start_with_grace(Duration::from_secs(30)).await
	}

	/// Start with full custom options.
	pub async fn start_with(_grace: Duration, socket_path: PathBuf, opts: BrokerOptions) -> Self {
		let handle = tokio::spawn(async move {
			run_server(opts).await.expect("broker exits cleanly");
		});
		// Wait up to 2s for the socket to appear.
		let deadline = std::time::Instant::now() + Duration::from_secs(2);
		while std::time::Instant::now() < deadline {
			if UnixStream::connect(&socket_path).await.is_ok() {
				break;
			}
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		Self { socket_path, _temp: tempfile::tempdir().expect("tempdir"), handle: Some(handle) }
	}

	// Intentionally allow some helpers to go unused per test binary.

	pub async fn shutdown(mut self) {
		if let Some(handle) = self.handle.take() {
			handle.abort();
			let _ = handle.await;
		}
	}
}

#[allow(dead_code, reason = "each test binary only uses a subset of the shared helpers")]
pub struct TestClient {
	pub session_id: String,
	pub reader:     BufReader<ReadHalf<UnixStream>>,
	pub writer:     WriteHalf<UnixStream>,
}

#[allow(dead_code, reason = "each test binary only uses a subset of the shared helpers")]
impl TestClient {
	pub async fn connect(socket: &Path, session_id: &str) -> Self {
		let stream = UnixStream::connect(socket).await.expect("connect");
		let (read, write) = split(stream);
		Self { session_id: session_id.into(), reader: BufReader::new(read), writer: write }
	}

	pub async fn send(&mut self, msg: &ClientMessage) {
		let mut bytes = serde_json::to_vec(msg).expect("serialize");
		bytes.push(b'\n');
		self.writer.write_all(&bytes).await.expect("write");
	}

	pub async fn hello(&mut self, pid: u32) -> ServerMessage {
		self
			.send(&ClientMessage::Hello {
				session_id: self.session_id.clone(),
				pid,
				cwd: PathBuf::from("/tmp/test"),
				project_name: Some("test".into()),
				started_at: now_ms(),
				open_files: Vec::new(),
			})
			.await;
		self.recv().await.expect("welcome")
	}

	pub async fn recv(&mut self) -> Option<ServerMessage> {
		let mut line = String::new();
		match timeout(Duration::from_secs(2), self.reader.read_line(&mut line)).await {
			Ok(Ok(0)) | Err(_) => None,
			Ok(Ok(_)) => Some(serde_json::from_str(line.trim_end()).expect("parse server msg")),
			Ok(Err(_)) => None,
		}
	}

	pub async fn recv_within(&mut self, budget: Duration) -> Option<ServerMessage> {
		let mut line = String::new();
		match timeout(budget, self.reader.read_line(&mut line)).await {
			Ok(Ok(0)) | Err(_) => None,
			Ok(Ok(_)) => Some(serde_json::from_str(line.trim_end()).expect("parse server msg")),
			Ok(Err(_)) => None,
		}
	}
}
