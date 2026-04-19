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

pub struct TestBroker {
	pub socket_path: PathBuf,
	pub temp:        TempDir,
	handle:          Option<JoinHandle<()>>,
}

impl TestBroker {
	pub async fn start() -> Self {
		let temp = tempfile::tempdir().expect("tempdir");
		std::fs::create_dir_all(temp.path().join(".git")).expect("init git marker");
		let socket_path = temp.path().join("edit-broker.sock");
		let opts = BrokerOptions {
			socket_path:        socket_path.clone(),
			grace:              Duration::from_secs(30),
			broadcast_capacity: 256,
		};
		let handle = tokio::spawn(async move {
			run_server(opts).await.expect("broker exits cleanly");
		});
		let deadline = std::time::Instant::now() + Duration::from_secs(2);
		while std::time::Instant::now() < deadline {
			if UnixStream::connect(&socket_path).await.is_ok() {
				break;
			}
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		Self { socket_path, temp, handle: Some(handle) }
	}

	pub fn workspace_root(&self) -> &Path {
		self.temp.path()
	}

	pub async fn shutdown(mut self) {
		if let Some(handle) = self.handle.take() {
			handle.abort();
			let _ = handle.await;
		}
	}
}

pub struct TestClient {
	pub session_id: String,
	reader:         BufReader<ReadHalf<UnixStream>>,
	writer:         WriteHalf<UnixStream>,
}

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

	pub async fn hello(&mut self, cwd: &Path) -> ServerMessage {
		self
			.send(&ClientMessage::Hello {
				session_id:   self.session_id.clone(),
				pid:          std::process::id(),
				cwd:          cwd.to_path_buf(),
				project_name: Some("test".into()),
				started_at:   now_ms(),
				open_files:   Vec::new(),
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
