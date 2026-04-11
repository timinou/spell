use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use loro::{LoroDoc, PeerID};
use ropey::{LineType, Rope};
use tree_sitter::{InputEdit, Parser, Point, Range, Tree};

use crate::{
	diff::{diff_lines, DiffHunk},
	error::{CodeEngineError, Result},
	language::{LanguageId, LanguageRegistry},
};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const BINARY_SAMPLE_BYTES: usize = 8192;
const PARSE_TIMEOUT_MICROS: u64 = 5_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
	pub start_byte: usize,
	pub old_end_byte: usize,
	pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
	pub input_edit: TextEdit,
	pub changed_ranges: Vec<Range>,
	pub version: u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code, reason = "snapshot keeps shared state for cheap clones and future diffing")]
pub struct BufferSnapshot {
	pub rope: Arc<Rope>,
	pub tree: Arc<Tree>,
	pub version: u64,
	pub dirty: bool,
	pub path: Option<PathBuf>,
	pub language: LanguageId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferInfo {
	pub path: Option<PathBuf>,
	pub language: LanguageId,
	pub version: u64,
	pub dirty: bool,
	pub line_count: usize,
}

#[derive(Debug, Clone)]
struct Revision {
	parent: Option<usize>,
	last_child: Option<usize>,
	forward: TextEdit,
	inverse: TextEdit,
}

#[derive(Debug, Clone)]
struct History {
	revisions: Vec<Revision>,
	current: usize,
}

impl History {
	fn new() -> Self {
		Self {
			revisions: vec![Revision {
				parent: None,
				last_child: None,
				forward: TextEdit { start_byte: 0, old_end_byte: 0, new_text: String::new() },
				inverse: TextEdit { start_byte: 0, old_end_byte: 0, new_text: String::new() },
			}],
			current: 0,
		}
	}

	fn record(&mut self, forward: TextEdit, inverse: TextEdit) {
		if self.current + 1 < self.revisions.len() {
			self.revisions.truncate(self.current + 1);
		}
		let next = self.revisions.len();
		self.revisions.push(Revision { parent: Some(self.current), last_child: None, forward, inverse });
		self.revisions[self.current].last_child = Some(next);
		self.current = next;
	}
}

pub struct CodeBuffer {
	rope: Rope,
	tree: Tree,
	parser: Parser,
	language: LanguageId,
	path: Option<PathBuf>,
	crdt: LoroDoc,
	history: History,
	version: u64,
	dirty: bool,
}

pub struct BufferRegistry {
	buffers: HashMap<PathBuf, CodeBuffer>,
	registry: Arc<LanguageRegistry>,
}

impl BufferRegistry {
	pub fn new(registry: Arc<LanguageRegistry>) -> Self {
		Self { buffers: HashMap::new(), registry }
	}

	pub fn open(&mut self, path: &Path) -> Result<&mut CodeBuffer> {
		let buffer = CodeBuffer::open(path, self.registry.clone())?;
		self.buffers.insert(path.to_path_buf(), buffer);
		self.buffers.get_mut(path).ok_or_else(|| CodeEngineError::Buffer("buffer insertion failed".to_string()))
	}

	pub fn close(&mut self, path: &Path) -> Result<()> {
		self.buffers.remove(path);
		Ok(())
	}

	pub fn list(&self) -> Vec<BufferInfo> {
		self.buffers.values().map(CodeBuffer::info).collect()
	}

	pub fn get(&self, path: &Path) -> Option<&CodeBuffer> { self.buffers.get(path) }
	pub fn get_mut(&mut self, path: &Path) -> Option<&mut CodeBuffer> { self.buffers.get_mut(path) }
}

impl CodeBuffer {
	pub fn open(path: &Path, registry: Arc<LanguageRegistry>) -> Result<Self> {
		let metadata = fs::metadata(path)?;
		if metadata.len() > MAX_FILE_BYTES {
			return Err(CodeEngineError::Buffer(format!("file too large: {} bytes", metadata.len())));
		}
		let bytes = fs::read(path)?;
		if bytes.iter().take(BINARY_SAMPLE_BYTES).any(|byte| *byte == 0) {
			return Err(CodeEngineError::Buffer(format!("binary file rejected: {}", path.display())));
		}
		let source = String::from_utf8(bytes).map_err(|err| CodeEngineError::Buffer(format!("invalid utf-8: {err}")))?;
		let language = registry.match_path(path).map(|profile| profile.id.clone()).ok_or_else(|| CodeEngineError::LanguageNotFound(path.to_path_buf()))?;
		Self::from_str_with_path(source, language, registry, Some(path.to_path_buf()))
	}

	pub fn from_str(source: &str, language_id: LanguageId, registry: Arc<LanguageRegistry>) -> Result<Self> {
		Self::from_str_with_path(source.to_string(), language_id, registry, None)
	}

	#[allow(deprecated, reason = "tree-sitter 0.25 exposes timeout on Parser and parse_with is still the stable incremental API")]
	fn from_str_with_path(source: String, language_id: LanguageId, registry: Arc<LanguageRegistry>, path: Option<PathBuf>) -> Result<Self> {
		let profile = registry.get(&language_id).ok_or_else(|| CodeEngineError::LanguageNotFound(path.clone().unwrap_or_default()))?.clone();
		let mut parser = Parser::new();
		parser.set_language(&profile.ts_language).map_err(|err| CodeEngineError::TreeSitter(err.to_string()))?;
		parser.set_timeout_micros(PARSE_TIMEOUT_MICROS);
		let rope = Rope::from_str(&source);
		let tree = Self::parse(&mut parser, &rope, None)?;
		let crdt = LoroDoc::new();
		crdt.set_peer_id(PeerID::from(1_u64)).map_err(|err| CodeEngineError::Buffer(err.to_string()))?;
		let text = crdt.get_text("content");
		let _ = text.insert(0, &source);
		Ok(Self { rope, tree, parser, language: language_id, path, crdt, history: History::new(), version: 0, dirty: false })
	}

	#[allow(deprecated, reason = "tree-sitter 0.25 exposes parse_with as the stable incremental API")]
	fn parse(parser: &mut Parser, rope: &Rope, old_tree: Option<&Tree>) -> Result<Tree> {
		parser.parse_with(
			&mut |byte_offset, _point| {
				let (chunk, start_byte) = rope.chunk(byte_offset);
				&chunk[(byte_offset - start_byte)..]
			},
			old_tree,
		).ok_or_else(|| CodeEngineError::Parse { language: String::new(), path: PathBuf::new(), message: "tree-sitter parse returned no tree".to_string() })
	}

	pub fn edit(&mut self, edit: TextEdit) -> Result<EditResult> {
		if edit.start_byte == edit.old_end_byte && edit.new_text.is_empty() {
			return Ok(EditResult { input_edit: edit, changed_ranges: Vec::new(), version: self.version });
		}
		let old_text = self.rope.slice(edit.start_byte..edit.old_end_byte).to_string();
		self.apply_text_edit(edit.clone())?;
		self.history.record(edit.clone(), TextEdit { start_byte: edit.start_byte, old_end_byte: edit.start_byte + edit.new_text.len(), new_text: old_text });
		self.version = self.version.saturating_add(1);
		self.dirty = true;
		Ok(EditResult { input_edit: edit, changed_ranges: vec![self.tree.root_node().range()], version: self.version })
	}

	pub fn edit_batch(&mut self, mut edits: Vec<TextEdit>) -> Result<Vec<EditResult>> {
		edits.sort_by_key(|edit| std::cmp::Reverse(edit.start_byte));
		let mut results = Vec::with_capacity(edits.len());
		for edit in edits { results.push(self.edit(edit)?); }
		Ok(results)
	}

	pub fn undo(&mut self) -> Result<Option<EditResult>> {
		let current = self.history.current;
		let Some(parent) = self.history.revisions[current].parent else { return Ok(None); };
		let inverse = self.history.revisions[current].inverse.clone();
		let result = self.apply_text_edit(inverse)?;
		self.history.current = parent;
		Ok(Some(result))
	}

	pub fn redo(&mut self) -> Result<Option<EditResult>> {
		let Some(next) = self.history.revisions[self.history.current].last_child else { return Ok(None); };
		let forward = self.history.revisions[next].forward.clone();
		let result = self.apply_text_edit(forward)?;
		self.history.current = next;
		Ok(Some(result))
	}

	fn apply_text_edit(&mut self, edit: TextEdit) -> Result<EditResult> {
		let start = byte_to_point(&self.rope, edit.start_byte);
		let old_end = byte_to_point(&self.rope, edit.old_end_byte);
		self.rope.remove(edit.start_byte..edit.old_end_byte);
		self.rope.insert(edit.start_byte, &edit.new_text);
		let new_end = byte_to_point(&self.rope, edit.start_byte + edit.new_text.len());
		let input_edit = InputEdit {
			start_byte: edit.start_byte,
			old_end_byte: edit.old_end_byte,
			new_end_byte: edit.start_byte + edit.new_text.len(),
			start_position: start,
			old_end_position: old_end,
			new_end_position: new_end,
		};
		self.tree.edit(&input_edit);
		self.tree = Self::parse(&mut self.parser, &self.rope, Some(&self.tree))?;
		let _ = self.crdt.get_text("content").delete(edit.start_byte, edit.old_end_byte - edit.start_byte);
		let _ = self.crdt.get_text("content").insert(edit.start_byte, &edit.new_text);
		self.dirty = true;
		Ok(EditResult { input_edit: edit, changed_ranges: vec![self.tree.root_node().range()], version: self.version })
	}

	pub fn snapshot(&self) -> BufferSnapshot {
		BufferSnapshot { rope: Arc::new(self.rope.clone()), tree: Arc::new(self.tree.clone()), version: self.version, dirty: self.dirty, path: self.path.clone(), language: self.language.clone() }
	}

	pub fn diff_from(&self, snapshot: BufferSnapshot) -> Vec<DiffHunk> {
	let old_source = snapshot.rope.to_string();
	let new_source = self.source();
	diff_lines(&old_source, &new_source)
}

	pub fn diff_from_disk(&self) -> Result<Vec<DiffHunk>> {
	let path = self.path.as_ref().ok_or_else(|| CodeEngineError::Buffer("buffer has no path".to_string()))?;
	let disk = fs::read_to_string(path)?;
	let temp = BufferSnapshot {
		rope: Arc::new(Rope::from_str(&disk)),
		tree: Arc::new(self.tree.clone()),
		version: self.version,
		dirty: false,
		path: self.path.clone(),
		language: self.language.clone(),
	};
	Ok(self.diff_from(temp))
}

	pub fn save(&mut self) -> Result<()> {
		let path = self.path.as_ref().ok_or_else(|| CodeEngineError::Buffer("buffer has no path".to_string()))?;
		fs::write(path, self.source())?;
		self.dirty = false;
		Ok(())
	}

	pub fn source(&self) -> String { self.rope.to_string() }
	pub const fn rope(&self) -> &Rope { &self.rope }
	pub const fn tree(&self) -> &Tree { &self.tree }
	pub const fn version(&self) -> u64 { self.version }
	pub const fn is_dirty(&self) -> bool { self.dirty }
	pub const fn language(&self) -> &LanguageId { &self.language }
	pub fn path(&self) -> Option<&Path> { self.path.as_deref() }
	pub fn info(&self) -> BufferInfo { BufferInfo { path: self.path.clone(), language: self.language.clone(), version: self.version, dirty: self.dirty, line_count: self.rope.len_lines(LineType::LF_CR) } }
}

fn byte_to_point(rope: &Rope, byte_offset: usize) -> Point {
	let line = rope.byte_to_line_idx(byte_offset, LineType::LF_CR);
	let column = byte_offset - rope.line_to_byte_idx(line, LineType::LF_CR);
	Point { row: line, column }
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

	use super::*;

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("builtins should load"))
	}

	fn fixture(name: &str) -> PathBuf {
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sources").join(name)
	}

	fn temp_path(name: &str) -> PathBuf {
		let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock ok").as_nanos();
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
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() }).expect("edit");
		assert!(buffer.source().starts_with("// hi\n"));
		assert_eq!(buffer.version(), 1);
		assert!(buffer.is_dirty());
		assert_eq!(buffer.tree().root_node().kind(), "program");
	}

	#[test]
	fn test_edit_deletes_text() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let first_line_end = source.find('\n').expect("newline") + 1;
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: first_line_end, new_text: String::new() }).expect("delete");
		assert!(!buffer.source().starts_with("export function greet"));
	}

	#[test]
	fn test_undo_restores_original() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() }).expect("edit");
		buffer.undo().expect("undo");
		assert_eq!(buffer.source(), source);
	}

	#[test]
	fn test_redo_reapplies() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() }).expect("edit");
		buffer.undo().expect("undo");
		buffer.redo().expect("redo");
		assert!(buffer.source().starts_with("// hi\n"));
	}

	#[test]
	fn test_undo_tree_branching() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "A".to_string() }).expect("edit A");
		buffer.edit(TextEdit { start_byte: 1, old_end_byte: 1, new_text: "B".to_string() }).expect("edit B");
		buffer.undo().expect("undo");
		buffer.edit(TextEdit { start_byte: 1, old_end_byte: 1, new_text: "C".to_string() }).expect("edit C");
		let out = buffer.source();
		assert!(out.starts_with("AC"));
		assert!(!out.contains('B'));
	}

	#[test]
	fn test_snapshot_and_diff() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let snapshot = buffer.snapshot();
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// hi\n".to_string() }).expect("edit");
		let hunks = buffer.diff_from(snapshot);
		assert_eq!(hunks.len(), 1);
		assert!(hunks[0].content.contains("+// hi"));
	}

	#[test]
	fn test_batch_edit() {
		let source = fs::read_to_string(fixture("hello.ts")).expect("fixture readable");
		let mut buffer = CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer");
		let marker = source.find("Greeter").expect("marker");
		let edits = vec![
			TextEdit { start_byte: 0, old_end_byte: 0, new_text: "// a\n".to_string() },
			TextEdit { start_byte: source.len(), old_end_byte: source.len(), new_text: "\n// z".to_string() },
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
		buffer.edit(TextEdit { start_byte: 0, old_end_byte: 0, new_text: "let x = 1;\n".to_string() }).expect("insert");
		assert_eq!(buffer.source(), "let x = 1;\n");
	}

	#[test]
	fn test_buffer_registry() {
		let path1 = temp_path("a.rs");
		let path2 = temp_path("b.ts");
		fs::write(&path1, fs::read_to_string(fixture("hello.rs")).expect("fixture readable")).expect("write a");
		fs::write(&path2, fs::read_to_string(fixture("hello.ts")).expect("fixture readable")).expect("write b");
		let mut reg = BufferRegistry::new(registry());
		reg.open(&path1).expect("open a");
		reg.open(&path2).expect("open b");
		assert_eq!(reg.list().len(), 2);
		assert!(reg.get(&path1).is_some());
		reg.close(&path1).expect("close a");
		assert_eq!(reg.list().len(), 1);
		assert!(reg.get(&path1).is_none());
	}
}
