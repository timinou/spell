use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime},
};

use dashmap::{DashMap, mapref::entry::Entry};
use parking_lot::Mutex;
use ropey::{LineType, Rope};
use tree_sitter::{InputEdit, Parser, Point, Range, Tree};

use crate::{
	diff::{DiffHunk, diff_lines},
	error::{CodeEngineError, Result},
	file_lock::{with_exclusive_lock, with_shared_lock},
	language::{LanguageId, LanguageRegistry},
	watcher::FileWatcher,
};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const BINARY_SAMPLE_BYTES: usize = 8192;
const PARSE_TIMEOUT_MICROS: u64 = 5_000_000;
const SAVE_LOCK_BUDGET: Duration = Duration::from_millis(500);
const REVALIDATE_LOCK_BUDGET: Duration = Duration::from_millis(100);

fn metadata_modified(metadata: &fs::Metadata) -> Option<SystemTime> {
	metadata.modified().ok()
}

fn is_newer_mtime(disk_mtime: Option<SystemTime>, buffer_mtime: Option<SystemTime>) -> bool {
	match (disk_mtime, buffer_mtime) {
		(Some(disk_mtime), Some(buffer_mtime)) => disk_mtime > buffer_mtime,
		(Some(_), None) => true,
		_ => false,
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
	pub start_byte:   usize,
	pub old_end_byte: usize,
	pub new_text:     String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
	pub input_edit:     TextEdit,
	pub changed_ranges: Vec<Range>,
	pub version:        u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code, reason = "snapshot keeps shared state for cheap clones and future diffing")]
pub struct BufferSnapshot {
	pub rope:     Arc<Rope>,
	pub tree:     Arc<Tree>,
	pub version:  u64,
	pub dirty:    bool,
	pub path:     Option<PathBuf>,
	pub language: LanguageId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferInfo {
	pub path:             Option<PathBuf>,
	pub language:         LanguageId,
	pub semantic_capable: bool,
	pub version:          u64,
	pub dirty:            bool,
	pub line_count:       usize,
}

#[derive(Debug, Clone)]
struct Revision {
	parent:          Option<usize>,
	last_child:      Option<usize>,
	forwards:        Vec<TextEdit>,
	inverses:        Vec<TextEdit>,
	session_id:      String,
	code_paths:      Vec<String>,
	revision_num:    u64,
	parent_revision: Option<u64>,
}

#[derive(Debug, Clone)]
struct History {
	revisions:         Vec<Revision>,
	current:           usize,
	saved_revision:    Option<usize>,
	next_revision_num: u64,
}

impl History {
	fn new() -> Self {
		Self {
			revisions:         vec![Revision {
				parent:          None,
				last_child:      None,
				forwards:        vec![TextEdit {
					start_byte:   0,
					old_end_byte: 0,
					new_text:     String::new(),
				}],
				inverses:        vec![TextEdit {
					start_byte:   0,
					old_end_byte: 0,
					new_text:     String::new(),
				}],
				session_id:      String::new(),
				code_paths:      Vec::new(),
				revision_num:    0,
				parent_revision: None,
			}],
			current:           0,
			saved_revision:    Some(0),
			next_revision_num: 1,
		}
	}

	fn record(&mut self, forward: TextEdit, inverse: TextEdit) {
		self.record_batch(vec![forward], vec![inverse]);
	}

	fn record_batch(&mut self, forwards: Vec<TextEdit>, inverses: Vec<TextEdit>) {
		self.record_batch_attributed(forwards, inverses, String::new(), Vec::new());
	}

	fn record_batch_attributed(
		&mut self,
		forwards: Vec<TextEdit>,
		inverses: Vec<TextEdit>,
		session_id: String,
		code_paths: Vec<String>,
	) {
		if self.current + 1 < self.revisions.len() {
			self.revisions.truncate(self.current + 1);
		}
		if self
			.saved_revision
			.is_some_and(|r| r >= self.revisions.len())
		{
			self.saved_revision = None;
		}
		let next = self.revisions.len();
		let parent_revision = Some(self.revisions[self.current].revision_num);
		let revision_num = self.next_revision_num;
		self.next_revision_num += 1;
		self.revisions.push(Revision {
			parent: Some(self.current),
			last_child: None,
			forwards,
			inverses,
			session_id,
			code_paths,
			revision_num,
			parent_revision,
		});
		self.revisions[self.current].last_child = Some(next);
		self.current = next;
	}

	fn current_summary(&self) -> Option<RevisionSummary> {
		let rev = self.revisions.get(self.current)?;
		if rev.revision_num == 0 && rev.session_id.is_empty() {
			return None;
		}
		Some(RevisionSummary {
			session_id: rev.session_id.clone(),
			code_paths: rev.code_paths.clone(),
			revision:   rev.revision_num,
		})
	}

	fn is_clean(&self) -> bool {
		self.saved_revision == Some(self.current)
	}

	const fn mark_saved(&mut self) {
		self.saved_revision = Some(self.current);
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionSummary {
	pub session_id: String,
	pub code_paths: Vec<String>,
	pub revision:   u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScopedUndoResult {
	pub applied: Option<RevisionSummary>,
	pub skipped: Vec<RevisionSummary>,
}

impl History {
	/// Walk back from `current`, skipping revisions whose `session_id` differs
	/// from `session_id`. The first matching revision is recorded as `applied`;
	/// peer revisions encountered are recorded in `skipped`. Current is moved
	/// to the target revision's parent so the caller can apply its inverses.
	///
	/// When no matching revision exists in the chain, `applied` is `None` and
	/// the chain up to the root is returned as `skipped`. Current is rolled
	/// back to the root in that case.
	fn undo_scoped(&mut self, session_id: &str) -> ScopedUndoResult {
		let mut skipped = Vec::new();
		let mut cursor = self.current;
		loop {
			let rev = &self.revisions[cursor];
			let Some(parent_idx) = rev.parent else {
				return ScopedUndoResult { applied: None, skipped };
			};
			if rev.session_id == session_id {
				let applied = RevisionSummary {
					session_id: rev.session_id.clone(),
					code_paths: rev.code_paths.clone(),
					revision:   rev.revision_num,
				};
				return ScopedUndoResult { applied: Some(applied), skipped };
			}
			skipped.push(RevisionSummary {
				session_id: rev.session_id.clone(),
				code_paths: rev.code_paths.clone(),
				revision:   rev.revision_num,
			});
			cursor = parent_idx;
		}
	}

	/// Walk forward via `last_child`, skipping peer revisions. The first
	/// matching revision becomes `applied`; peer revisions are recorded in
	/// `skipped`.
	fn redo_scoped(&mut self, session_id: &str) -> ScopedUndoResult {
		let mut skipped = Vec::new();
		let mut cursor = self.current;
		loop {
			let Some(next_idx) = self.revisions[cursor].last_child else {
				return ScopedUndoResult { applied: None, skipped };
			};
			let next = &self.revisions[next_idx];
			if next.session_id == session_id {
				let applied = RevisionSummary {
					session_id: next.session_id.clone(),
					code_paths: next.code_paths.clone(),
					revision:   next.revision_num,
				};
				return ScopedUndoResult { applied: Some(applied), skipped };
			}
			skipped.push(RevisionSummary {
				session_id: next.session_id.clone(),
				code_paths: next.code_paths.clone(),
				revision:   next.revision_num,
			});
			cursor = next_idx;
		}
	}
}

pub struct CodeBuffer {
	rope:       Rope,
	tree:       Tree,
	parser:     Parser,
	language:   LanguageId,
	registry:   Arc<LanguageRegistry>,
	path:       Option<PathBuf>,
	history:    History,
	version:    u64,
	dirty:      bool,
	disk_mtime: Option<SystemTime>,
}

pub struct BufferRegistry {
	buffers:  DashMap<PathBuf, Arc<Mutex<CodeBuffer>>>,
	registry: Arc<LanguageRegistry>,
	watcher:  Option<FileWatcher>,
}

fn registry_key(path: &Path) -> PathBuf {
	fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

impl BufferRegistry {
	pub fn new(registry: Arc<LanguageRegistry>) -> Self {
		Self::new_with_watcher(registry, FileWatcher::new().ok())
	}

	pub fn new_with_watcher(registry: Arc<LanguageRegistry>, watcher: Option<FileWatcher>) -> Self {
		Self { buffers: DashMap::new(), registry, watcher }
	}

	pub const fn watcher(&self) -> Option<&FileWatcher> {
		self.watcher.as_ref()
	}

	pub fn watcher_active(&self) -> bool {
		self.watcher().is_some_and(FileWatcher::active)
	}

	pub fn watched_count(&self) -> usize {
		self.watcher().map_or(0, FileWatcher::watched_count)
	}

	pub fn is_stale(&self, path: &Path) -> bool {
		self.watcher().is_some_and(|watcher| watcher.is_stale(path))
	}

	pub fn open(&self, path: &Path) -> Result<Arc<Mutex<CodeBuffer>>> {
		self.open_inner(path, false)
	}

	pub fn open_or_create(&self, path: &Path) -> Result<Arc<Mutex<CodeBuffer>>> {
		self.open_inner(path, true)
	}

	fn open_inner(&self, path: &Path, allow_create: bool) -> Result<Arc<Mutex<CodeBuffer>>> {
		let key = registry_key(path);
		if self
			.watcher()
			.is_some_and(|watcher| !watcher.is_stale(&key))
			&& let Some(buffer) = self.get(&key)
		{
			return Ok(buffer);
		}
		self.reload_if_stale(&key)?;
		if let Some(buffer) = self.get(&key) {
			return Ok(buffer);
		}
		let candidate = Arc::new(Mutex::new(if allow_create && !key.exists() {
			CodeBuffer::create(&key, self.registry.clone())?
		} else {
			CodeBuffer::open(&key, self.registry.clone())?
		}));
		match self.buffers.entry(key.clone()) {
			Entry::Occupied(entry) => Ok(entry.get().clone()),
			Entry::Vacant(entry) => {
				if let Some(watcher) = self.watcher() {
					let _ = watcher.watch(&key);
					watcher.clear_stale(&key);
				}
				entry.insert(candidate.clone());
				Ok(candidate)
			},
		}
	}

	pub fn reload_if_stale(&self, path: &Path) -> Result<()> {
		let key = registry_key(path);
		if let Some(watcher) = self.watcher()
			&& watcher.is_stale(&key)
		{
			if let Some(buffer) = self.get(&key) {
				let disk_source = match fs::read_to_string(&key) {
					Ok(source) => Some(source),
					Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
					Err(error) => return Err(error.into()),
				};
				let disk_mtime = match fs::metadata(&key) {
					Ok(metadata) => metadata_modified(&metadata),
					Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
					Err(error) => return Err(error.into()),
				};
				let mut guard = buffer.lock();
				if disk_source
					.as_deref()
					.is_some_and(|source| source == guard.source())
				{
					guard.disk_mtime = disk_mtime;
					watcher.clear_stale(&key);
					return Ok(());
				}
			}
			self.close(&key)?;
			watcher.clear_stale(&key);
			return Ok(());
		}
		let Some(buffer) = self.get(&key) else {
			return Ok(());
		};
		let should_close = with_shared_lock(&key, REVALIDATE_LOCK_BUDGET, || {
			let disk_mtime = match fs::metadata(&key) {
				Ok(metadata) => metadata_modified(&metadata),
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
				Err(error) => return Err(error.into()),
			};
			let mut guard = buffer.lock();
			if guard.dirty || !is_newer_mtime(disk_mtime, guard.disk_mtime) {
				return Ok(false);
			}
			let disk_source = fs::read_to_string(&key)?;
			if disk_source == guard.source() {
				guard.disk_mtime = disk_mtime;
				return Ok(false);
			}
			Ok(true)
		})?;
		if should_close {
			self.close(&key)?;
		}
		Ok(())
	}

	pub fn close(&self, path: &Path) -> Result<()> {
		let key = registry_key(path);
		self.buffers.remove(&key);
		if let Some(watcher) = self.watcher() {
			let _ = watcher.unwatch(&key);
		}
		Ok(())
	}

	pub fn list(&self) -> Vec<BufferInfo> {
		self
			.buffers
			.iter()
			.map(|entry| entry.value().lock().info())
			.collect()
	}

	pub fn get(&self, path: &Path) -> Option<Arc<Mutex<CodeBuffer>>> {
		let key = registry_key(path);
		self.buffers.get(&key).map(|entry| entry.value().clone())
	}
}

impl CodeBuffer {
	pub fn open(path: &Path, registry: Arc<LanguageRegistry>) -> Result<Self> {
		let metadata = fs::metadata(path)?;
		if metadata.len() > MAX_FILE_BYTES {
			return Err(CodeEngineError::Buffer(format!("file too large: {} bytes", metadata.len())));
		}
		let disk_mtime = metadata_modified(&metadata);
		let bytes = fs::read(path)?;
		if bytes
			.iter()
			.take(BINARY_SAMPLE_BYTES)
			.any(|byte| *byte == 0)
		{
			return Err(CodeEngineError::Buffer(format!("binary file rejected: {}", path.display())));
		}
		let source = String::from_utf8(bytes)
			.map_err(|err| CodeEngineError::Buffer(format!("invalid utf-8: {err}")))?;
		let language = Self::language_for_path(path, registry.as_ref())?;
		Self::from_str_with_path(source, language, registry, Some(path.to_path_buf()), disk_mtime)
	}

	pub fn create(path: &Path, registry: Arc<LanguageRegistry>) -> Result<Self> {
		let language = Self::language_for_create_path(path, registry.as_ref());
		Self::from_str_with_path(String::new(), language, registry, Some(path.to_path_buf()), None)
	}

	fn language_for_path(path: &Path, registry: &LanguageRegistry) -> Result<LanguageId> {
		if let Some(profile) = registry.match_path(path) {
			return Ok(profile.id.clone());
		}
		let bytes = fs::read(path)?;
		if bytes
			.iter()
			.take(BINARY_SAMPLE_BYTES)
			.any(|byte| *byte == 0)
		{
			return Err(CodeEngineError::Buffer(format!("binary file rejected: {}", path.display())));
		}
		String::from_utf8(bytes)
			.map(|_| LanguageId::new("text"))
			.map_err(|err| CodeEngineError::Buffer(format!("invalid utf-8: {err}")))
	}

	fn language_for_create_path(path: &Path, registry: &LanguageRegistry) -> LanguageId {
		registry
			.match_path(path)
			.map_or_else(|| LanguageId::new("text"), |profile| profile.id.clone())
	}

	pub fn from_str(
		source: &str,
		language_id: LanguageId,
		registry: Arc<LanguageRegistry>,
	) -> Result<Self> {
		Self::from_str_with_path(source.to_string(), language_id, registry, None, None)
	}

	#[allow(
		deprecated,
		reason = "tree-sitter 0.25 exposes timeout on Parser and parse_with is still the stable \
		          incremental API"
	)]
	fn from_str_with_path(
		source: String,
		language_id: LanguageId,
		registry: Arc<LanguageRegistry>,
		path: Option<PathBuf>,
		disk_mtime: Option<SystemTime>,
	) -> Result<Self> {
		let profile = registry
			.get(&language_id)
			.ok_or_else(|| CodeEngineError::LanguageNotFound(path.clone().unwrap_or_default()))?
			.clone();
		let mut parser = Parser::new();
		parser
			.set_language(&profile.ts_language)
			.map_err(|err| CodeEngineError::TreeSitter(err.to_string()))?;
		parser.set_timeout_micros(PARSE_TIMEOUT_MICROS);
		let rope = Rope::from_str(&source);
		let tree = Self::parse(&mut parser, &rope, None)?;
		Ok(Self {
			rope,
			tree,
			parser,
			language: language_id,
			registry,
			path,
			history: History::new(),
			version: 0,
			dirty: false,
			disk_mtime,
		})
	}

	#[allow(
		deprecated,
		reason = "tree-sitter 0.25 exposes parse_with as the stable incremental API"
	)]
	fn parse(parser: &mut Parser, rope: &Rope, old_tree: Option<&Tree>) -> Result<Tree> {
		parser
			.parse_with(
				&mut |byte_offset, _point| {
					let (chunk, start_byte) = rope.chunk(byte_offset);
					&chunk[(byte_offset - start_byte)..]
				},
				old_tree,
			)
			.ok_or_else(|| CodeEngineError::Parse {
				language: String::new(),
				path:     PathBuf::new(),
				message:  "tree-sitter parse returned no tree".to_string(),
			})
	}

	pub fn edit(&mut self, edit: TextEdit) -> Result<EditResult> {
		if edit.start_byte == edit.old_end_byte && edit.new_text.is_empty() {
			return Ok(EditResult {
				input_edit:     edit,
				changed_ranges: Vec::new(),
				version:        self.version,
			});
		}

		let source_len = self.source().len();
		if edit.start_byte > edit.old_end_byte || edit.old_end_byte > source_len {
			return Err(CodeEngineError::Edit(format!(
				"Edit range {}..{} is out of bounds for buffer length {source_len}",
				edit.start_byte, edit.old_end_byte,
			)));
		}

		let original_rope = self.rope.clone();
		let original_tree = self.tree.clone();
		let original_history = self.history.clone();
		let original_version = self.version;
		let original_dirty = self.dirty;
		let original_had_error = self.tree.root_node().has_error();
		let restore = |buffer: &mut Self| {
			buffer.rope = original_rope.clone();
			buffer.tree = original_tree.clone();
			buffer.history = original_history.clone();
			buffer.version = original_version;
			buffer.dirty = original_dirty;
		};

		let old_text = self
			.rope
			.slice(edit.start_byte..edit.old_end_byte)
			.to_string();
		let result = match self.apply_text_mutation(edit.clone()) {
			Ok(result) => result,
			Err(error) => {
				restore(self);
				return Err(error);
			},
		};
		if !original_had_error && self.tree.root_node().has_error() {
			self.tree = match Self::parse(&mut self.parser, &self.rope, None) {
				Ok(tree) => tree,
				Err(error) => {
					restore(self);
					return Err(error);
				},
			};
			if self.tree.root_node().has_error() {
				restore(self);
				return Err(CodeEngineError::Edit(
					"Edit would leave the buffer structurally invalid. Re-anchor the target or include \
					 an explicit separator."
						.into(),
				));
			}
		}

		self.history.record(edit.clone(), TextEdit {
			start_byte:   edit.start_byte,
			old_end_byte: edit.start_byte + edit.new_text.len(),
			new_text:     old_text,
		});
		self.version = self.version.saturating_add(1);
		self.dirty = true;
		Ok(EditResult { version: self.version, ..result })
	}

	pub fn edit_batch(&mut self, mut edits: Vec<TextEdit>) -> Result<Vec<EditResult>> {
		edits.sort_by_key(|e| std::cmp::Reverse(e.start_byte));
		if edits.is_empty() {
			return Ok(Vec::new());
		}

		let source_len = self.source().len();
		for edit in &edits {
			if edit.start_byte > edit.old_end_byte || edit.old_end_byte > source_len {
				return Err(CodeEngineError::Edit(format!(
					"Edit range {}..{} is out of bounds for buffer length {source_len}",
					edit.start_byte, edit.old_end_byte,
				)));
			}
		}
		let mut sorted_ranges = edits
			.iter()
			.map(|edit| (edit.start_byte, edit.old_end_byte))
			.collect::<Vec<_>>();
		sorted_ranges.sort_unstable_by_key(|(start_byte, _)| *start_byte);
		for pair in sorted_ranges.windows(2) {
			if pair[0].1 > pair[1].0 {
				return Err(CodeEngineError::Edit(
					"Batch edits overlap in the original buffer. Split them into separate structural \
					 edits or tighten the target."
						.into(),
				));
			}
		}

		let original_rope = self.rope.clone();
		let original_tree = self.tree.clone();
		let original_history = self.history.clone();
		let original_version = self.version;
		let original_dirty = self.dirty;
		let original_had_error = self.tree.root_node().has_error();
		let restore = |buffer: &mut Self| {
			buffer.rope = original_rope.clone();
			buffer.tree = original_tree.clone();
			buffer.history = original_history.clone();
			buffer.version = original_version;
			buffer.dirty = original_dirty;
		};

		let mut results = Vec::with_capacity(edits.len());
		let mut all_forwards = Vec::new();
		let mut all_inverses = Vec::new();
		for edit in edits {
			if edit.start_byte == edit.old_end_byte && edit.new_text.is_empty() {
				results.push(EditResult {
					input_edit:     edit,
					changed_ranges: Vec::new(),
					version:        self.version,
				});
				continue;
			}
			let old_text = self
				.rope
				.slice(edit.start_byte..edit.old_end_byte)
				.to_string();
			let inverse = TextEdit {
				start_byte:   edit.start_byte,
				old_end_byte: edit.start_byte + edit.new_text.len(),
				new_text:     old_text,
			};
			let result = match self.apply_text_mutation(edit.clone()) {
				Ok(result) => result,
				Err(error) => {
					restore(self);
					return Err(error);
				},
			};
			all_forwards.push(edit);
			all_inverses.push(inverse);
			results.push(result);
		}
		if !original_had_error && self.tree.root_node().has_error() {
			self.tree = match Self::parse(&mut self.parser, &self.rope, None) {
				Ok(tree) => tree,
				Err(error) => {
					restore(self);
					return Err(error);
				},
			};
			if self.tree.root_node().has_error() {
				restore(self);
				return Err(CodeEngineError::Edit(
					"Edit batch would leave the buffer structurally invalid. Re-anchor the target or \
					 include an explicit separator."
						.into(),
				));
			}
		}
		if !all_forwards.is_empty() {
			all_inverses.reverse();
			self.history.record_batch(all_forwards, all_inverses);
			self.version = self.version.saturating_add(1);
			self.dirty = true;
			for result in &mut results {
				result.version = self.version;
			}
		}
		Ok(results)
	}

	pub fn undo(&mut self) -> Result<Option<EditResult>> {
		let current = self.history.current;
		let Some(parent) = self.history.revisions[current].parent else {
			return Ok(None);
		};
		let inverses = self.history.revisions[current].inverses.clone();
		let mut last_result = None;
		for inv in &inverses {
			last_result = Some(self.apply_text_mutation(inv.clone())?);
		}
		self.history.current = parent;
		self.dirty = !self.history.is_clean();
		Ok(last_result)
	}

	pub fn redo(&mut self) -> Result<Option<EditResult>> {
		let Some(next) = self.history.revisions[self.history.current].last_child else {
			return Ok(None);
		};
		let forwards = self.history.revisions[next].forwards.clone();
		let mut last_result = None;
		for fwd in &forwards {
			last_result = Some(self.apply_text_mutation(fwd.clone())?);
		}
		self.history.current = next;
		self.dirty = !self.history.is_clean();
		Ok(last_result)
	}

	fn apply_text_mutation(&mut self, edit: TextEdit) -> Result<EditResult> {
		let start = byte_to_point(&self.rope, edit.start_byte);
		let old_end = byte_to_point(&self.rope, edit.old_end_byte);
		self.rope.remove(edit.start_byte..edit.old_end_byte);
		self.rope.insert(edit.start_byte, &edit.new_text);
		let new_end = byte_to_point(&self.rope, edit.start_byte + edit.new_text.len());
		let input_edit = InputEdit {
			start_byte:       edit.start_byte,
			old_end_byte:     edit.old_end_byte,
			new_end_byte:     edit.start_byte + edit.new_text.len(),
			start_position:   start,
			old_end_position: old_end,
			new_end_position: new_end,
		};
		self.tree.edit(&input_edit);
		self.tree = Self::parse(&mut self.parser, &self.rope, Some(&self.tree))?;
		self.dirty = true;
		Ok(EditResult {
			input_edit:     edit,
			changed_ranges: vec![self.tree.root_node().range()],
			version:        self.version,
		})
	}

	pub fn snapshot(&self) -> BufferSnapshot {
		BufferSnapshot {
			rope:     Arc::new(self.rope.clone()),
			tree:     Arc::new(self.tree.clone()),
			version:  self.version,
			dirty:    self.dirty,
			path:     self.path.clone(),
			language: self.language.clone(),
		}
	}

	pub fn diff_from(&self, snapshot: BufferSnapshot) -> Vec<DiffHunk> {
		let old_source = snapshot.rope.to_string();
		let new_source = self.source();
		diff_lines(&old_source, &new_source)
	}

	pub fn diff_from_disk(&self) -> Result<Vec<DiffHunk>> {
		let path = self
			.path
			.as_ref()
			.ok_or_else(|| CodeEngineError::Buffer("buffer has no path".to_string()))?;
		let disk = match fs::read_to_string(path) {
			Ok(disk) => disk,
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
			Err(error) => return Err(error.into()),
		};
		Ok(diff_lines(&disk, &self.source()))
	}

	pub fn save(&mut self) -> Result<()> {
		self.save_with_watcher(None)
	}

	pub fn save_with_watcher(&mut self, watcher: Option<&FileWatcher>) -> Result<()> {
		let path = self
			.path
			.as_ref()
			.ok_or_else(|| CodeEngineError::Buffer("buffer has no path".to_string()))?
			.clone();
		if let Some(parent) = path
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			fs::create_dir_all(parent)?;
		}
		let source = self.source();
		if let Some(watcher) = watcher {
			watcher.mark_self_write(&path, None);
			watcher.clear_stale(&path);
		}
		let disk_mtime = with_exclusive_lock(&path, SAVE_LOCK_BUDGET, || {
			if self.disk_mtime.is_some()
				&& let Ok(metadata) = fs::metadata(&path)
			{
				let disk_mtime = metadata_modified(&metadata);
				if is_newer_mtime(disk_mtime, self.disk_mtime) {
					return Err(CodeEngineError::ExternalModification {
						path: path.clone(),
						disk_mtime,
						buffer_mtime: self.disk_mtime,
					});
				}
			}
			fs::write(&path, &source)?;
			Ok(fs::metadata(&path)
				.ok()
				.and_then(|metadata| metadata_modified(&metadata)))
		})?;
		if let Some(watcher) = watcher {
			watcher.mark_self_write(&path, disk_mtime);
			watcher.clear_stale(&path);
		}
		self.disk_mtime = disk_mtime;
		self.history.mark_saved();
		self.dirty = false;
		Ok(())
	}

	pub fn source(&self) -> String {
		self.rope.to_string()
	}

	pub const fn rope(&self) -> &Rope {
		&self.rope
	}

	pub const fn tree(&self) -> &Tree {
		&self.tree
	}

	pub const fn registry(&self) -> &Arc<LanguageRegistry> {
		&self.registry
	}

	pub const fn version(&self) -> u64 {
		self.version
	}

	pub const fn is_dirty(&self) -> bool {
		self.dirty
	}

	pub const fn language(&self) -> &LanguageId {
		&self.language
	}

	pub fn path(&self) -> Option<&Path> {
		self.path.as_deref()
	}

	pub fn info(&self) -> BufferInfo {
		BufferInfo {
			path:             self.path.clone(),
			language:         self.language.clone(),
			semantic_capable: self.language.as_str() != "text",
			version:          self.version,
			dirty:            self.dirty,
			line_count:       self.rope.len_lines(LineType::LF_CR),
		}
	}
}

fn byte_to_point(rope: &Rope, byte_offset: usize) -> Point {
	let line = rope.byte_to_line_idx(byte_offset, LineType::LF_CR);
	let column = byte_offset - rope.line_to_byte_idx(line, LineType::LF_CR);
	Point { row: line, column }
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		sync::Arc,
		time::{SystemTime, UNIX_EPOCH},
	};

	use filetime::{FileTime, set_file_mtime};

	use super::*;

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("builtins should load"))
	}

	fn fixture(name: &str) -> PathBuf {
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("tests/fixtures/sources")
			.join(name)
	}

	fn temp_path(name: &str) -> PathBuf {
		let stamp = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock ok")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-code-engine-{stamp}-{name}"))
	}

	#[test]
	fn test_open_and_read() {
		let buffer = CodeBuffer::open(&fixture("hello.ts"), registry()).expect("open fixture");
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		assert_eq!(buffer.source(), source);
		assert_eq!(buffer.tree().root_node().kind(), "program");
		assert_eq!(buffer.version(), 0);
		assert!(!buffer.is_dirty());
	}

	#[test]
	fn test_edit_inserts_text() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() })
			.expect("edit");
		assert!(buffer.source().starts_with("// hi\n"));
		assert_eq!(buffer.version(), 1);
		assert!(buffer.is_dirty());
		assert_eq!(buffer.tree().root_node().kind(), "program");
	}

	#[test]
	fn test_edit_deletes_text() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let first_line_end = source.find('\n').expect("newline") + 1;
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: first_line_end,
				new_text:     String::new(),
			})
			.expect("delete");
		assert!(!buffer.source().starts_with("export function greet"));
	}

	#[test]
	fn test_undo_restores_original() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() })
			.expect("edit");
		buffer.undo().expect("undo");
		assert_eq!(buffer.source(), source);
	}

	#[test]
	fn test_redo_reapplies() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() })
			.expect("edit");
		buffer.undo().expect("undo");
		buffer.redo().expect("redo");
		assert!(buffer.source().starts_with("// hi\n"));
	}

	#[test]
	fn test_undo_tree_branching() {
		let source = "export const value = 1;\n";
		let mut buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: source.len(),
				new_text:     "export const value = 2;\n".to_string(),
			})
			.expect("edit A");
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: "export const value = 2;\n".len(),
				new_text:     "export const value = 3;\n".to_string(),
			})
			.expect("edit B");
		buffer.undo().expect("undo");
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: "export const value = 2;\n".len(),
				new_text:     "export const value = 4;\n".to_string(),
			})
			.expect("edit C");
		let out = buffer.source();
		assert!(out.contains("value = 4"));
		assert!(!out.contains("value = 3"));
	}

	#[test]
	fn test_snapshot_and_diff() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let snapshot = buffer.snapshot();
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() })
			.expect("edit");
		let hunks = buffer.diff_from(snapshot);
		assert_eq!(hunks.len(), 1);
		assert!(hunks[0].content.contains("+// hi"));
	}

	#[test]
	fn test_batch_edit() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer =
			CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let marker = source.find("Greeter").expect("marker");
		let edits = vec![
			TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// a\n".to_string() },
			TextEdit {
				start_byte:   source.len(),
				old_end_byte: source.len(),
				new_text:     "\n// z".to_string(),
			},
			TextEdit { start_byte: marker, old_end_byte: marker, new_text: "X".to_string() },
		];
		buffer.edit_batch(edits).expect("batch");
		let out = buffer.source();
		assert!(out.starts_with("// a\n"));
		assert!(out.contains('X'));
		assert!(out.ends_with("// z"));
	}

	#[test]
	fn test_empty_file() {
		let path = temp_path("empty.ts");
		fs::write(&path, "").expect("write empty file");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open empty file");
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: 0,
				new_text:     "let x = 1;\n".to_string(),
			})
			.expect("insert");
		assert_eq!(buffer.source(), "let x = 1;\n");
	}

	#[test]
	fn test_create_buffer_saves_missing_parent_dirs() {
		let path = temp_path("nested/created.ts");
		let mut buffer = CodeBuffer::create(&path, registry()).expect("create buffer");
		buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: 0,
				new_text:     "export const value = 42;\n".to_string(),
			})
			.expect("insert");
		let diff = buffer.diff_from_disk().expect("diff");
		assert_eq!(diff.len(), 1);
		assert!(diff[0].content.contains("+export const value = 42;"));
		buffer.save().expect("save");
		assert_eq!(fs::read_to_string(&path).expect("saved file"), "export const value = 42;\n");
	}

	#[test]
	fn test_buffer_registry_open_or_create_missing_file() {
		let path = temp_path("registry-create/new.rs");
		let reg = BufferRegistry::new(registry());
		let buffer = reg.open_or_create(&path).expect("create buffer");
		let buffer = buffer.lock();
		assert_eq!(buffer.source(), "");
		assert_eq!(buffer.language(), &LanguageId::new("rust"));
		drop(buffer);
		assert!(reg.get(&path).is_some());
	}

	#[test]
	fn test_buffer_registry() {
		let path1 = temp_path("a.rs");
		let path2 = temp_path("b.ts");
		fs::write(&path1, fs::read_to_string(fixture("hello.rs")).expect("fixture readable"))
			.expect("write a");
		fs::write(&path2, fs::read_to_string(fixture("hello.ts")).expect("fixture readable"))
			.expect("write b");
		let reg = BufferRegistry::new(registry());
		reg.open(&path1).expect("open a");
		reg.open(&path2).expect("open b");
		assert_eq!(reg.list().len(), 2);
		assert!(reg.get(&path1).is_some());
		reg.close(&path1).expect("close a");
		assert_eq!(reg.list().len(), 1);
		assert!(reg.get(&path1).is_none());
	}
	#[test]
	fn test_buffer_registry_allows_parallel_locks() {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let path1 = temp_path("parallel-a.rs");
		let path2 = temp_path("parallel-b.org");
		fs::write(&path1, fs::read_to_string(fixture("hello.rs")).expect("fixture readable"))
			.expect("write a");
		fs::write(&path2, "* ITEM Parallel\n:PROPERTIES:\n:CUSTOM_ID: PAR-1\n:END:\n")
			.expect("write b");

		let reg = Arc::new(BufferRegistry::new(registry()));
		let buf1 = reg.open(&path1).expect("open a");
		let buf2 = reg.open(&path2).expect("open b");

		let handle1 = {
			let buf1 = buf1.clone();
			thread::spawn(move || {
				let _guard = buf1.lock();
				thread::sleep(Duration::from_millis(200));
			})
		};
		let handle2 = {
			let buf2 = buf2.clone();
			thread::spawn(move || {
				let start = Instant::now();
				let _guard = buf2.lock();
				start.elapsed()
			})
		};

		handle1.join().expect("thread a");
		let elapsed = handle2.join().expect("thread b");
		assert!(
			elapsed < Duration::from_millis(100),
			"different buffers should not block each other: {elapsed:?}"
		);
	}

	#[test]
	fn test_batch_undo_is_atomic() {
		let source = "abc";
		let mut buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit_batch(vec![
				TextEdit { start_byte: 0, old_end_byte: 0, new_text: "X".into() },
				TextEdit { start_byte: 3, old_end_byte: 3, new_text: "Y".into() },
			])
			.expect("batch");
		assert_eq!(buffer.source(), "XabcY");
		buffer.undo().expect("undo");
		assert_eq!(buffer.source(), source);
		buffer.redo().expect("redo");
		assert_eq!(buffer.source(), "XabcY");
	}

	#[test]
	fn test_dirty_cleared_on_undo_to_saved() {
		let source = "abc";
		let mut buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "X".into() })
			.expect("edit");
		assert!(buffer.is_dirty());
		buffer.undo().expect("undo");
		assert!(!buffer.is_dirty(), "undo back to initial saved state should clear dirty");
	}

	#[test]
	fn test_dirty_tracking_with_save() {
		let path = temp_path("dirty-track.ts");
		fs::write(&path, "abc").expect("write fixture");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open");
		assert!(!buffer.is_dirty());

		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "X".into() })
			.expect("edit");
		assert!(buffer.is_dirty());

		buffer.undo().expect("undo");
		assert!(!buffer.is_dirty(), "undo to original saved state");

		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "Y".into() })
			.expect("edit");
		buffer.save().expect("save");
		assert!(!buffer.is_dirty(), "save should clear dirty");

		buffer
			.edit(TextEdit { start_byte: 1, old_end_byte: 1, new_text: "Z".into() })
			.expect("edit");
		assert!(buffer.is_dirty());
		buffer.undo().expect("undo");
		assert!(!buffer.is_dirty(), "undo back to post-save state");
		buffer.redo().expect("redo");
		assert!(buffer.is_dirty(), "redo away from saved state");
	}

	#[test]
	fn test_dirty_past_saved_state() {
		let path = temp_path("dirty-past.ts");
		fs::write(&path, "abc").expect("write fixture");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open");

		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "X".into() })
			.expect("edit 1");
		buffer.save().expect("save");
		assert!(!buffer.is_dirty());

		buffer
			.edit(TextEdit { start_byte: 1, old_end_byte: 1, new_text: "Y".into() })
			.expect("edit 2");
		buffer.undo().expect("undo");
		assert!(!buffer.is_dirty(), "undo to saved state");
		buffer.undo().expect("undo past saved");
		assert!(buffer.is_dirty(), "undo past saved state should be dirty");
		buffer.redo().expect("redo to saved");
		assert!(!buffer.is_dirty(), "redo back to saved state");
	}

	#[test]
	fn test_open_unknown_extension_uses_text_fallback() {
		let path = temp_path("fallback-notes.kdl");
		fs::write(&path, "alpha\nbeta\n").expect("write fallback file");
		let buffer = CodeBuffer::open(&path, registry()).expect("open fallback text file");
		assert_eq!(buffer.language(), &LanguageId::new("text"));
		assert_eq!(buffer.source(), "alpha\nbeta\n");
	}

	#[test]
	fn test_create_unknown_extension_uses_text_fallback() {
		let path = temp_path("fallback-create.txt");
		let mut buffer = CodeBuffer::create(&path, registry()).expect("create fallback buffer");
		assert_eq!(buffer.language(), &LanguageId::new("text"));
		buffer
			.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "hello\n".into() })
			.expect("edit fallback buffer");
		buffer.save().expect("save fallback buffer");
		assert_eq!(fs::read_to_string(&path).expect("read saved file"), "hello\n");
	}

	#[test]
	fn test_text_fallback_history_round_trips_multiple_revisions() {
		let path = temp_path("fallback-history.txt");
		let mut buffer = CodeBuffer::create(&path, registry()).expect("create fallback buffer");
		let revisions = ["alpha\n", "beta\ngamma\n", "delta\n", "epsilon\nzeta\neta\n"];

		for revision in revisions {
			let current = buffer.source();
			buffer
				.edit(TextEdit {
					start_byte:   0,
					old_end_byte: current.len(),
					new_text:     revision.to_string(),
				})
				.expect("replace revision");
		}
		assert_eq!(buffer.source(), "epsilon\nzeta\neta\n");

		for expected in ["delta\n", "beta\ngamma\n", "alpha\n", ""] {
			buffer.undo().expect("undo revision");
			assert_eq!(buffer.source(), expected);
		}
		for expected in revisions {
			buffer.redo().expect("redo revision");
			assert_eq!(buffer.source(), expected);
		}
	}

	#[test]
	fn test_text_fallback_preserves_bom_and_crlf_on_save() {
		let path = temp_path("fallback-bom.txt");
		fs::write(&path, "\u{feff}first\r\nsecond\r\n").expect("write fixture");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open fallback buffer");
		let start = buffer.source().find("second").expect("find second");
		let end = start + "second".len();
		buffer
			.edit(TextEdit { start_byte: start, old_end_byte: end, new_text: "updated".into() })
			.expect("edit fallback buffer");
		buffer.save().expect("save fallback buffer");
		assert_eq!(
			fs::read_to_string(&path).expect("read saved file"),
			"\u{feff}first\r\nupdated\r\n"
		);
	}

	#[test]
	fn test_edit_rejects_structurally_invalid_result() {
		let source = "export const value = 1;\n";
		let mut buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer");

		let err = buffer
			.edit(TextEdit {
				start_byte:   0,
				old_end_byte: source.len(),
				new_text:     "export const = ;\n".into(),
			})
			.expect_err("reject invalid syntax");
		assert!(err.to_string().contains("structurally invalid"));
		assert_eq!(buffer.source(), source);
		assert_eq!(buffer.version(), 0);
	}

	#[test]
	fn test_batch_rejects_overlapping_ranges() {
		let mut buffer =
			CodeBuffer::from_str("abcdef", LanguageId::new("typescript"), registry()).expect("buffer");
		let err = buffer
			.edit_batch(vec![
				TextEdit { start_byte: 1, old_end_byte: 3, new_text: "X".into() },
				TextEdit { start_byte: 2, old_end_byte: 4, new_text: "Y".into() },
			])
			.expect_err("reject overlap");
		assert!(err.to_string().contains("overlap"));
		assert_eq!(buffer.source(), "abcdef");
		assert_eq!(buffer.version(), 0);
	}

	#[test]
	fn buffer_external_write_reuses_cached_buffer_when_disk_unchanged() {
		let path = temp_path("registry-stable.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let reg = BufferRegistry::new_with_watcher(registry(), None);
		let first = reg.open(&path).expect("open first");
		let second = reg.open(&path).expect("open second");
		assert!(Arc::ptr_eq(&first, &second));
	}

	#[test]
	fn saved_buffer_keeps_history_across_registry_reopen() {
		let path = temp_path("registry-save-history.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let reg = BufferRegistry::new(registry());
		if !reg.watcher_active() {
			return;
		}
		let first = reg.open(&path).expect("open first");
		{
			let mut buffer = first.lock();
			let end = buffer.source().len();
			buffer
				.edit_batch(vec![TextEdit {
					start_byte:   0,
					old_end_byte: end,
					new_text:     "export const value = 2;\n".into(),
				}])
				.expect("edit batch");
			buffer.save_with_watcher(reg.watcher()).expect("save");
		}
		let reopened = reg.open(&path).expect("reopen");
		assert!(Arc::ptr_eq(&first, &reopened), "self-saved buffer should remain open for undo/redo",);
		let mut reopened = reopened.lock();
		reopened.undo().expect("undo");
		assert_eq!(reopened.source(), "export const value = 1;\n");
		reopened.redo().expect("redo");
		assert_eq!(reopened.source(), "export const value = 2;\n");
	}

	#[test]
	fn buffer_external_write_reloads_after_disk_change() {
		let path = temp_path("registry-external-write.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let reg = BufferRegistry::new_with_watcher(registry(), None);
		let first = reg.open(&path).expect("open first");
		assert_eq!(first.lock().source(), "export const value = 1;\n");

		fs::write(&path, "export const value = 2;\n").expect("external write");
		let bumped =
			FileTime::from_system_time(SystemTime::now() + std::time::Duration::from_secs(5));
		set_file_mtime(&path, bumped).expect("bump mtime");

		let second = reg.open(&path).expect("open second");
		assert!(!Arc::ptr_eq(&first, &second));
		assert_eq!(second.lock().source(), "export const value = 2;\n");
	}

	#[test]
	fn buffer_external_write_save_reports_external_modification() {
		let path = temp_path("save-external-write.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open");
		let end = buffer.source().len();
		buffer
			.edit(TextEdit {
				start_byte:   end,
				old_end_byte: end,
				new_text:     "export const local = 2;\n".into(),
			})
			.expect("edit");

		fs::write(&path, "export const value = 99;\n").expect("external write");
		let bumped =
			FileTime::from_system_time(SystemTime::now() + std::time::Duration::from_secs(5));
		set_file_mtime(&path, bumped).expect("bump mtime");

		let err = buffer.save().expect_err("reject external modification");
		match err {
			CodeEngineError::ExternalModification { path: error_path, .. } => {
				assert_eq!(error_path, path);
			},
			other => panic!("expected external modification, got {other:?}"),
		}
		assert_eq!(fs::read_to_string(&path).expect("read disk"), "export const value = 99;\n");
	}

	#[test]
	fn concurrent_opens_same_path_return_same_arc() {
		use std::thread;

		let path = temp_path("same-path.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let registry = Arc::new(BufferRegistry::new_with_watcher(registry(), None));
		let handles: Vec<_> = (0..8)
			.map(|_| {
				let registry = Arc::clone(&registry);
				let path = path.clone();
				thread::spawn(move || registry.open(&path).expect("open"))
			})
			.collect();
		let buffers: Vec<_> = handles
			.into_iter()
			.map(|handle| handle.join().expect("thread join"))
			.collect();
		for buffer in buffers.iter().skip(1) {
			assert!(Arc::ptr_eq(&buffers[0], buffer));
		}
	}

	#[test]
	fn buffer_watcher_marks_stale_after_external_write() {
		use std::{thread, time::Duration};

		let path = temp_path("watcher-stale.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let registry = BufferRegistry::new(registry());
		if !registry.watcher_active() {
			return;
		}
		registry.open(&path).expect("open");
		fs::write(&path, "export const value = 2;\n").expect("external write");
		let mut stale = false;
		for _ in 0..20 {
			if registry.is_stale(&path) {
				stale = true;
				break;
			}
			thread::sleep(Duration::from_millis(10));
		}
		assert!(stale, "watcher should mark path stale after external write");
	}

	#[test]
	fn buffer_save_times_out_on_lock_contention() {
		use std::{thread, time::Duration};

		let path = temp_path("lock-timeout.ts");
		fs::write(&path, "export const value = 1;\n").expect("write fixture");
		let mut buffer = CodeBuffer::open(&path, registry()).expect("open");
		let end = buffer.source().len();
		buffer
			.edit(TextEdit {
				start_byte:   end,
				old_end_byte: end,
				new_text:     "export const local = 2;\n".into(),
			})
			.expect("edit");

		let held_path = path.clone();
		let lock_thread = thread::spawn(move || {
			crate::file_lock::with_exclusive_lock(&held_path, Duration::from_millis(50), || {
				thread::sleep(Duration::from_millis(750));
				Ok(())
			})
			.expect("hold exclusive lock");
		});
		thread::sleep(Duration::from_millis(50));

		let err = buffer
			.save()
			.expect_err("save should time out behind held lock");
		match err {
			CodeEngineError::LockTimeout { path: error_path, .. } => assert_eq!(error_path, path),
			other => panic!("expected lock timeout, got {other:?}"),
		}
		lock_thread.join().expect("lock thread join");
	}
}
