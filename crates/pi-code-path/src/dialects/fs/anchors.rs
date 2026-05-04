use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::resolver::traits::FsAnchorContext;
use crate::types::NodeRef;

/// Anchor classification for filesystem entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsAnchor {
	Hidden,
	Ignored,
	Code,
	Doc,
	Image,
	Binary,
	Large,
	Lockfile,
}

/// Default anchor context with standard extension / basename sets.
pub struct DefaultFsAnchorContext {
	root:            PathBuf,
	code_exts:       HashSet<String>,
	image_exts:      HashSet<String>,
	doc_exts:        HashSet<String>,
	lockfile_names:  HashSet<String>,
}

impl DefaultFsAnchorContext {
	pub fn new(root: impl Into<PathBuf>) -> Self {
		let mut code_exts = HashSet::new();
		for &ext in &[
			"ts", "tsx", "js", "jsx", "rs", "py", "go", "hs", "c", "cpp", "cc", "cxx", "h",
			"hpp", "java", "kt", "scala", "rb", "php", "swift", "cs", "fs", "fsx", "ml",
			"mli", "erl", "ex", "exs", "clj", "cljs", "elm", "lua", "vim", "sh", "bash",
			"zsh", "fish", "ps1", "sql", "r", "m", "mm", "groovy", "dart", "json", "yaml",
			"yml", "toml", "xml", "html", "css", "scss", "sass", "less", "vue", "svelte",
		] {
			code_exts.insert(ext.to_string());
		}

		let mut image_exts = HashSet::new();
		for &ext in &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif"] {
			image_exts.insert(ext.to_string());
		}

		let mut doc_exts = HashSet::new();
		for &ext in &["md", "org", "rst", "txt", "adoc", "asciidoc"] {
			doc_exts.insert(ext.to_string());
		}

		let mut lockfile_names = HashSet::new();
		for &name in &[
			"Cargo.lock",
			"bun.lock",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"poetry.lock",
			"Pipfile.lock",
			"Gemfile.lock",
		] {
			lockfile_names.insert(name.to_string());
		}

		DefaultFsAnchorContext {
			root:           root.into(),
			code_exts,
			image_exts,
			doc_exts,
			lockfile_names,
		}
	}
}

impl FsAnchorContext for DefaultFsAnchorContext {
	fn is_code_extension(&self, ext: &str) -> bool {
		self.code_exts.contains(ext)
	}

	fn is_image_extension(&self, ext: &str) -> bool {
		self.image_exts.contains(ext)
	}

	fn is_doc_extension(&self, ext: &str) -> bool {
		self.doc_exts.contains(ext)
	}

	fn is_lockfile_basename(&self, name: &str) -> bool {
		self.lockfile_names.contains(name)
	}

	fn root(&self) -> Option<&Path> {
		Some(&self.root)
	}
}

/// Classify a `NodeRef` into its matching `FsAnchor` set.
pub fn classify(node: &NodeRef, ctx: &dyn FsAnchorContext) -> Vec<FsAnchor> {
	let mut anchors = Vec::new();
	let path = Path::new(&node.locator);
	let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
	let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

	if name.starts_with('.') {
		anchors.push(FsAnchor::Hidden);
	}

	if ctx.is_lockfile_basename(name) {
		anchors.push(FsAnchor::Lockfile);
	}

	if !ext.is_empty() {
		if ctx.is_code_extension(ext) {
			anchors.push(FsAnchor::Code);
		}
		if ctx.is_doc_extension(ext) {
			anchors.push(FsAnchor::Doc);
		}
		if ctx.is_image_extension(ext) {
			anchors.push(FsAnchor::Image);
		}
	}

	if node.kind == "§file" {
		let abs = ctx
			.root()
			.map(|r| r.join(&node.locator))
			.unwrap_or_else(|| PathBuf::from(&node.locator));

		if let Ok(meta) = fs::metadata(&abs) {
			let size = meta.len();
			if size > 1_048_576 {
				anchors.push(FsAnchor::Large);
			}

			let is_binary = if size > 0 {
				let max = std::cmp::min(size as usize, 8192);
				match fs::read(&abs) {
					Ok(data) => {
						let sample = &data[..max];
						std::str::from_utf8(sample).is_err()
					}
					Err(_) => true,
				}
			} else {
				false
			};

			if is_binary {
				anchors.push(FsAnchor::Binary);
			}
		}

		if let Some(root) = ctx.root() {
			let (gitignore, _) = ignore::gitignore::Gitignore::new(root.join(".gitignore"));
			if let Ok(rel) = abs.strip_prefix(root) {
				let abs_path = root.join(rel);
				let is_dir = abs_path.is_dir();
				// `matched_path_or_any_parents` walks ancestor dirs so `target/`-style patterns hit `target/foo`.
				if gitignore.matched_path_or_any_parents(rel, is_dir).is_ignore() {
					anchors.push(FsAnchor::Ignored);
				}
			}
		}
	}

	anchors
}

/// Map an anchor name string (e.g. "code", "image", "lockfile") to the
/// matching `FsAnchor` enum, returning true when this anchor name applies.
pub fn anchor_name_matches(anchor: FsAnchor, name: &str) -> bool {
	matches!(
		(anchor, name),
		(FsAnchor::Hidden, "hidden")
			| (FsAnchor::Ignored, "ignored")
			| (FsAnchor::Code, "code")
			| (FsAnchor::Doc, "doc")
			| (FsAnchor::Image, "image")
			| (FsAnchor::Binary, "binary")
			| (FsAnchor::Large, "large")
			| (FsAnchor::Lockfile, "lockfile")
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	fn ctx(root: PathBuf) -> DefaultFsAnchorContext {
		DefaultFsAnchorContext::new(root)
	}

	fn node(locator: &str, kind: &str) -> NodeRef {
		NodeRef {
			locator:     locator.to_string(),
			range:       0..0,
			kind:        kind.to_string(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: vec![],
		}
	}

	#[test]
	fn anchor_hidden_dotfile() {
		let dir = tempfile::tempdir().unwrap();
		let n = node(".env", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Hidden));
	}

	#[test]
	fn anchor_code_extension() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
		let n = node("main.rs", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Code));
	}

	#[test]
	fn anchor_doc_extension() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("readme.md"), "# Hello").unwrap();
		let n = node("readme.md", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Doc));
	}

	#[test]
	fn anchor_image_extension() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("icon.png"), "fake").unwrap();
		let n = node("icon.png", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Image));
	}

	#[test]
	fn anchor_lockfile_basename() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("Cargo.lock"), "").unwrap();
		let n = node("Cargo.lock", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Lockfile));
	}

	#[test]
	fn anchor_binary_utf8_sniff_fails() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data.bin"), vec![0u8, 159, 146, 150]).unwrap();
		let n = node("data.bin", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Binary));
	}

	#[test]
	fn anchor_large_file() {
		let dir = tempfile::tempdir().unwrap();
		let big = vec![0u8; 1_048_577];
		fs::write(dir.path().join("big.bin"), big).unwrap();
		let n = node("big.bin", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Large));
	}

	#[test]
	fn anchor_text_not_binary() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("hello.txt"), "Hello, world!").unwrap();
		let n = node("hello.txt", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(!anchors.contains(&FsAnchor::Binary));
	}

	#[test]
	fn anchor_gitignore_ignored() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
		fs::create_dir(dir.path().join("target")).unwrap();
		fs::write(dir.path().join("target/out"), "").unwrap();
		let n = node("target/out", "§file");
		let anchors = classify(&n, &ctx(dir.path().to_path_buf()));
		assert!(anchors.contains(&FsAnchor::Ignored));
	}
}
