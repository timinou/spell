//! Async pipe reading utilities for Unix.
//!
//! Wraps a `std::io::PipeReader` in `tokio::net::unix::pipe::Receiver` so
//! command-substitution output can be drained via async I/O. This avoids the
//! pre-fix deadlock where `std::io::read_to_string` blocked the calling
//! tokio worker thread while the substituted command's `wait()` future
//! relied on the same runtime making progress (BUG-375).

use std::{io, os::unix::io::OwnedFd};

use tokio::net::unix::pipe;

pub(crate) struct AsyncPipeReader(pipe::Receiver);

impl AsyncPipeReader {
	pub(crate) fn new(reader: std::io::PipeReader) -> io::Result<Self> {
		Ok(Self(pipe::Receiver::from_file(std::fs::File::from(OwnedFd::from(reader)))?))
	}

	pub(crate) async fn read_to_string(&mut self) -> io::Result<String> {
		use tokio::io::AsyncReadExt;
		let mut s = String::new();
		self.0.read_to_string(&mut s).await?;
		Ok(s)
	}
}
