use std::{
	collections::BTreeMap,
	fmt, fs,
	io::{BufReader, BufWriter, Write},
	path::{Path, PathBuf},
	time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Debug)]
pub enum WorkspaceCacheError {
	Io(std::io::Error),
	Serialize(bincode::Error),
	InvalidRoot(PathBuf),
}

impl fmt::Display for WorkspaceCacheError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(error) => write!(f, "I/O error: {error}"),
			Self::Serialize(error) => write!(f, "serialization error: {error}"),
			Self::InvalidRoot(path) => write!(f, "invalid workspace root {}", path.display()),
		}
	}
}

impl std::error::Error for WorkspaceCacheError {}

impl From<std::io::Error> for WorkspaceCacheError {
	fn from(value: std::io::Error) -> Self {
		Self::Io(value)
	}
}

impl From<bincode::Error> for WorkspaceCacheError {
	fn from(value: bincode::Error) -> Self {
		Self::Serialize(value)
	}
}

pub type Result<T> = std::result::Result<T, WorkspaceCacheError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct FileFingerprint {
	pub size:           u64,
	pub modified_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct WorkspaceFingerprint {
	pub root:     PathBuf,
	pub git_head: Option<String>,
	pub files:    BTreeMap<PathBuf, FileFingerprint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheStatus {
	Missing,
	Fresh,
	Stale { reason: String },
}

pub trait PersistentCacheEntry {
	fn fingerprint(&self) -> &WorkspaceFingerprint;
}

#[derive(Debug, Clone)]
pub struct CacheStore {
	directory: PathBuf,
}

impl CacheStore {
	pub fn new(directory: impl Into<PathBuf>) -> Self {
		Self { directory: directory.into() }
	}

	pub fn directory(&self) -> &Path {
		&self.directory
	}

	pub fn entry_path(&self, name: &str) -> PathBuf {
		self.directory.join(format!("{name}.bin"))
	}

	pub fn load<T>(&self, name: &str) -> Result<Option<T>>
	where
		T: DeserializeOwned,
	{
		let path = self.entry_path(name);
		if !path.exists() {
			return Ok(None);
		}
		let file = fs::File::open(path)?;
		let reader = BufReader::new(file);
		let entry = bincode::deserialize_from(reader)?;
		Ok(Some(entry))
	}

	pub fn save<T>(&self, name: &str, entry: &T) -> Result<()>
	where
		T: Serialize,
	{
		fs::create_dir_all(&self.directory)?;
		let path = self.entry_path(name);
		let file = fs::File::create(path)?;
		let mut writer = BufWriter::new(file);
		// Pass `&mut writer` so we retain ownership and can explicitly flush
		// the BufWriter before drop. `BufWriter::drop` swallows flush errors
		// silently — if the final partial buffer fails to write the on-disk
		// file is truncated and `load()` later fails with bincode
		// "failed to fill whole buffer". Discovered while wiring CacheStore
		// into the recall engine hot path (was masked for org_index and
		// code_graph because their saves are infrequent and small).
		bincode::serialize_into(&mut writer, entry)?;
		writer
			.flush()
			.map_err(WorkspaceCacheError::Io)?;
		Ok(())
	}

	pub fn fingerprint_root(
		&self,
		root: &Path,
		matches_source: &dyn Fn(&Path) -> bool,
	) -> Result<WorkspaceFingerprint> {
		fingerprint_root(root, matches_source)
	}

	pub fn status<T>(
		&self,
		name: &str,
		root: &Path,
		matches_source: &dyn Fn(&Path) -> bool,
	) -> Result<CacheStatus>
	where
		T: DeserializeOwned + PersistentCacheEntry,
	{
		let Some(entry) = self.load::<T>(name)? else {
			return Ok(CacheStatus::Missing);
		};
		let current = self.fingerprint_root(root, matches_source)?;
		if entry.fingerprint().git_head != current.git_head {
			return Ok(CacheStatus::Stale { reason: "git HEAD changed".into() });
		}
		if entry.fingerprint().files != current.files {
			return Ok(CacheStatus::Stale { reason: "workspace files changed".into() });
		}
		Ok(CacheStatus::Fresh)
	}
}

pub fn fingerprint_root(
	root: &Path,
	matches_source: &dyn Fn(&Path) -> bool,
) -> Result<WorkspaceFingerprint> {
	if !root.is_dir() {
		return Err(WorkspaceCacheError::InvalidRoot(root.to_path_buf()));
	}
	let mut files = BTreeMap::new();
	for entry in ignore::WalkBuilder::new(root)
		.hidden(false)
		.git_ignore(true)
		.git_exclude(true)
		.build()
	{
		let entry = entry.map_err(|error| std::io::Error::other(error.to_string()))?;
		if !entry
			.file_type()
			.is_some_and(|file_type| file_type.is_file())
		{
			continue;
		}
		let path = entry.into_path();
		let relative = path
			.strip_prefix(root)
			.unwrap_or(path.as_path())
			.to_path_buf();
		if relative.starts_with(".spell") || !matches_source(&path) {
			continue;
		}
		let metadata = fs::metadata(&path)?;
		files.insert(relative, FileFingerprint::from_metadata(&metadata)?);
	}
	Ok(WorkspaceFingerprint { root: root.to_path_buf(), git_head: read_git_head(root), files })
}

impl FileFingerprint {
	pub fn from_metadata(metadata: &fs::Metadata) -> Result<Self> {
		let modified_at_ms = metadata
			.modified()?
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64;
		Ok(Self { size: metadata.len(), modified_at_ms })
	}
}

pub fn read_git_head(root: &Path) -> Option<String> {
	let git_dir = root.join(".git");
	let head_path = git_dir.join("HEAD");
	let head = fs::read_to_string(head_path).ok()?;
	let trimmed = head.trim();
	if let Some(reference) = trimmed.strip_prefix("ref: ") {
		let ref_path = git_dir.join(reference);
		fs::read_to_string(ref_path)
			.ok()
			.map(|value| value.trim().to_string())
	} else {
		Some(trimmed.to_string())
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
	};

	use super::*;

	#[derive(Debug, Clone, Serialize, Deserialize)]
	struct TestEntry {
		value:       String,
		fingerprint: WorkspaceFingerprint,
	}

	impl PersistentCacheEntry for TestEntry {
		fn fingerprint(&self) -> &WorkspaceFingerprint {
			&self.fingerprint
		}
	}

	fn temp_dir(name: &str) -> PathBuf {
		std::env::temp_dir().join(format!("pi-workspace-cache-{name}-{}", std::process::id()))
	}

	fn is_org_source(path: &Path) -> bool {
		path.extension().and_then(|extension| extension.to_str()) == Some("org")
	}

	#[test]
	fn cache_round_trip_preserves_entry() {
		let temp_dir = temp_dir("round-trip");
		let _ = fs::remove_dir_all(&temp_dir);
		fs::create_dir_all(&temp_dir).expect("temp dir should be created");
		let store = CacheStore::new(&temp_dir);
		let entry = TestEntry {
			value:       "payload".into(),
			fingerprint: WorkspaceFingerprint {
				root:     PathBuf::from("/tmp/project"),
				git_head: Some("abc123".into()),
				files:    BTreeMap::new(),
			},
		};
		store.save("unit", &entry).expect("save should succeed");
		let loaded = store
			.load::<TestEntry>("unit")
			.expect("load should succeed")
			.expect("entry");
		assert_eq!(loaded.value, "payload");
		assert_eq!(loaded.fingerprint.git_head.as_deref(), Some("abc123"));
		let _ = fs::remove_dir_all(temp_dir);
	}

	#[test]
	fn status_tracks_missing_fresh_and_file_drift() {
		let root = temp_dir("status");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join(".spell/org")).expect("cache dir should be created");
		fs::write(root.join("item.org"), "* ITEM Alpha\n").expect("org file should be written");
		fs::write(root.join("README.md"), "docs").expect("docs should be written");
		fs::write(root.join(".spell/org/workspace.bin"), "cache")
			.expect("cache file should be written");
		let store = CacheStore::new(root.join(".spell/org"));
		assert_eq!(
			store
				.status::<TestEntry>("workspace", &root, &is_org_source)
				.expect("missing status"),
			CacheStatus::Missing,
		);
		let fingerprint = store
			.fingerprint_root(&root, &is_org_source)
			.expect("fingerprint");
		assert_eq!(fingerprint.files.keys().cloned().collect::<Vec<_>>(), vec![PathBuf::from(
			"item.org"
		)]);
		store
			.save("workspace", &TestEntry {
				value:       "payload".into(),
				fingerprint: fingerprint.clone(),
			})
			.expect("save should succeed");
		assert_eq!(
			store
				.status::<TestEntry>("workspace", &root, &is_org_source)
				.expect("fresh status"),
			CacheStatus::Fresh,
		);
		fs::write(root.join("second.org"), "* ITEM Beta\n")
			.expect("second org file should be written");
		assert_eq!(
			store
				.status::<TestEntry>("workspace", &root, &is_org_source)
				.expect("stale status"),
			CacheStatus::Stale { reason: "workspace files changed".into() },
		);
		let _ = fs::remove_dir_all(root);
	}
}
