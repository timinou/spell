//! Text dialect resolver.
//!
//! Operates on opaque bytes with structural axes (`§line`, `§chunk`, `§para`).

pub mod axes;
pub mod line_index;
pub mod mutation;
pub mod para_index;
pub mod qualifiers;
pub mod regex_match;
pub mod stream;

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use pi_text_search::{SearchConfig, SearchFile, SearchParams, search_file_list};
use rayon::prelude::*;

use super::fs::anchors::DefaultFsAnchorContext;
use crate::{
	ast::{CodePath, Combinator, FsLocator, FsSegment, Head, Locator, Predicate, Step},
	dialects::fs::walker::{WalkOpts, walk},
	resolver::traits::{CancellationToken, FormatExtractor, Resolver},
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

/// Top-level text resolver.
pub struct TextResolver {
	pub format_extractors: Vec<Arc<dyn FormatExtractor>>,
	pub root:              PathBuf,
	pub gitignore:         bool,
}

impl TextResolver {
	pub fn new(root: PathBuf) -> Self {
		Self { format_extractors: Vec::new(), root, gitignore: true }
	}

	pub fn with_extractors(mut self, extractors: Vec<Arc<dyn FormatExtractor>>) -> Self {
		self.format_extractors = extractors;
		self
	}

	pub fn with_gitignore(mut self, gitignore: bool) -> Self {
		self.gitignore = gitignore;
		self
	}
}

impl Resolver for TextResolver {
	fn resolve(
		&self,
		path: &CodePath,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic> {
		let fs_loc = match &path.locator {
			Locator::Fs(fs) => fs,
			Locator::Uri(_) => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: "TextResolver received URI locator".into(),
					span:    None,
				});
			},
		};

		if let Some(query) = &path.query
			&& let Some(pattern) = fast_line_search_pattern(query, path.qualifier.is_none())
		{
			return Ok(run_fast_line_search_locator(
				pattern,
				fs_loc,
				self.root.clone(),
				self.gitignore,
				cancel,
			));
		}

		let _anchor_ctx = DefaultFsAnchorContext::new(self.root.clone());
		let opts =
			WalkOpts { hidden: true, gitignore: self.gitignore, root: self.root.clone() };
		let walk_results = walk(fs_loc, &opts, cancel);
		let file_paths: Vec<PathBuf> = walk_results
			.into_iter()
			.filter_map(|r| r.ok())
			.filter(|n| n.kind == "§file")
			.map(|n| {
				if std::path::Path::new(&n.locator).is_absolute() {
					PathBuf::from(n.locator)
				} else {
					self.root.join(n.locator)
				}
			})
			.collect();

		if file_paths.is_empty() {
			return Ok(Vec::new());
		}

		let query = match &path.query {
			Some(q) => q,
			None => {
				// No query — build file nodes. If a content qualifier is
				// set (FEAT-689 routing of bare-file `#raw`/`#bytes`/…),
				// apply it now so we return inlined content rather than
				// a bare §file stub.
				let mut file_nodes: Vec<NodeRef> = file_paths
					.iter()
					.map(|p| NodeRef {
						locator:     p.to_string_lossy().to_string(),
						range:       0..p.metadata().map(|m| m.len() as usize).unwrap_or(0),
						kind:        "§file".to_string(),
						content:     None,
						metadata:    HashMap::new(),
						diagnostics: Vec::new(),
					})
					.collect();
				if let Some(qual) = &path.qualifier {
					let mut out = Vec::new();
					for n in file_nodes {
						let abs = PathBuf::from(&n.locator);
						let content = match std::fs::read(&abs) {
							Ok(c) => c,
							Err(_) => {
								out.push(n);
								continue;
							},
						};
						match qualifiers::resolve_qualifier(&n, &content, qual, &self.format_extractors) {
							Ok(m) => out.push(m),
							Err(d) => {
								let mut n = n;
								n.diagnostics.push(d);
								out.push(n);
							},
						}
					}
					file_nodes = out;
				}
				return Ok(file_nodes);
			},
		};

		let head_step = &query.head;
		if let Some(pattern) = fast_line_search_pattern(query, path.qualifier.is_none()) {
			return Ok(run_fast_line_search(pattern, &file_paths, cancel));
		}

		// Apply head step to every file in parallel. Per-file scans are pure
		// (no shared state), and the output set is already unordered downstream
		// (callers re-group by file locator). We use rayon's thread pool to
		// saturate cores on multi-file globs; cancellation is polled per file.
		let nodes: Vec<NodeRef> = file_paths
			.par_iter()
			.flat_map_iter(|path| {
				if cancel.is_cancelled() {
					return Vec::new().into_iter();
				}
				match std::fs::read(path) {
					Ok(content) => apply_step(&content, head_step, path).into_iter(),
					Err(e) => vec![NodeRef {
						locator:     path.to_string_lossy().to_string(),
						range:       0..0,
						kind:        "§file".to_string(),
						content:     None,
						metadata:    HashMap::new(),
						diagnostics: vec![Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: format!("cannot read file: {e}"),
							span:    None,
						}],
					}]
					.into_iter(),
				}
			})
			.collect();
		let mut nodes = nodes;

		// Process combinator chain.
		for (combinator, step) in &query.chain {
			match combinator {
				Combinator::NextSibling => {
					nodes = expand_context(&nodes, step, &file_paths, cancel, true);
				},
				Combinator::PrevSibling => {
					nodes = expand_context(&nodes, step, &file_paths, cancel, false);
				},
				_ => {
					// Ignore unsupported combinators at this layer.
				},
			}
		}

		// Apply qualifier.
		if let Some(qual) = &path.qualifier {
			let mut out = Vec::new();
			for n in nodes {
				let path = PathBuf::from(&n.locator.split("::").next().unwrap_or(&n.locator));
				let content = match std::fs::read(&path) {
					Ok(c) => c,
					Err(_) => {
						out.push(n);
						continue;
					},
				};
				match qualifiers::resolve_qualifier(&n, &content, qual, &self.format_extractors) {
					Ok(m) => out.push(m),
					Err(d) => {
						let mut n = n;
						n.diagnostics.push(d);
						out.push(n);
					},
				}
			}
			nodes = out;
		}

		Ok(nodes)
	}
}

fn fast_line_search_pattern<'a>(
	query: &'a crate::ast::Query,
	no_qualifier: bool,
) -> Option<&'a str> {
	if !no_qualifier || !query.chain.is_empty() {
		return None;
	}
	let step = &query.head;
	if !matches!(&step.head, Head::NodeKind(kind) if kind == "line") {
		return None;
	}
	if step.predicates.len() != 1 {
		return None;
	}
	match &step.predicates[0] {
		Predicate::TextMatch(pattern) | Predicate::LiteralMatch(pattern) => Some(pattern.as_str()),
		_ => None,
	}
}

fn run_fast_line_search_locator(
	pattern: &str,
	fs_loc: &FsLocator,
	root: PathBuf,
	gitignore: bool,
	cancel: &CancellationToken,
) -> Vec<NodeRef> {
	let locator_pattern = fs_locator_to_glob_pattern(fs_loc);
	let has_glob = locator_pattern
		.bytes()
		.any(|b| matches!(b, b'*' | b'?' | b'[' | b']' | b'{' | b'}'));
	let candidate = if locator_pattern.is_empty() || locator_pattern == "." {
		root.clone()
	} else {
		root.join(&locator_pattern)
	};
	let mut config = if !has_glob && candidate.exists() {
		SearchConfig::new(pattern, candidate)
	} else {
		let mut config = SearchConfig::new(pattern, root);
		config.glob = if locator_pattern.is_empty() || locator_pattern == "**" {
			None
		} else {
			Some(locator_pattern)
		};
		config
	};
	config.gitignore = gitignore;
	config.hidden = true;
	let result = match pi_text_search::search_files(&config) {
		Ok(result) => result,
		Err(err) => return text_search_error(err.to_string()),
	};
	matches_to_line_nodes(result.matches, cancel)
}

fn fs_locator_to_glob_pattern(loc: &FsLocator) -> String {
	let mut out = String::new();
	for seg in &loc.segments {
		match seg {
			FsSegment::Literal(s) => out.push_str(s),
			FsSegment::Star => out.push('*'),
			FsSegment::DoubleStar => out.push_str("**"),
			FsSegment::Question => out.push('?'),
			FsSegment::CharClass(chars) => {
				out.push('[');
				for c in chars {
					out.push(*c);
				}
				out.push(']');
			},
			FsSegment::Brace { items, exclusions: _ } => {
				out.push('{');
				out.push_str(&items.join(","));
				out.push('}');
			},
		}
	}
	out
}

fn text_search_error(message: String) -> Vec<NodeRef> {
	vec![NodeRef {
		locator:     "<text-search>".to_string(),
		range:       0..0,
		kind:        "§error".to_string(),
		content:     None,
		metadata:    HashMap::new(),
		diagnostics: vec![Diagnostic { variant: DiagnosticVariant::ParseError, message, span: None }],
	}]
}

fn matches_to_line_nodes(
	matches: Vec<pi_text_search::SearchMatch>,
	cancel: &CancellationToken,
) -> Vec<NodeRef> {
	let mut nodes = Vec::with_capacity(matches.len());
	for matched in matches {
		if cancel.is_cancelled() {
			break;
		}
		let start = matched.absolute_byte_offset as usize;
		let end = start.saturating_add(matched.line.len());
		let mut metadata = HashMap::new();
		metadata.insert("line".to_string(), serde_json::Value::Number(matched.line_number.into()));
		metadata.insert("shape".to_string(), serde_json::Value::String("match".to_string()));
		if matched.truncated {
			metadata.insert("truncated".to_string(), serde_json::Value::Bool(true));
		}
		nodes.push(NodeRef {
			locator: format!("{}::<line {}>", matched.path, matched.line_number),
			range: start..end,
			kind: "§line".to_string(),
			content: Some(Content::Text { value: matched.line }),
			metadata,
			diagnostics: Vec::new(),
		});
	}
	nodes
}
fn run_fast_line_search(
	pattern: &str,
	file_paths: &[PathBuf],
	cancel: &CancellationToken,
) -> Vec<NodeRef> {
	let files: Vec<SearchFile> = file_paths
		.iter()
		.map(|path| SearchFile {
			path:          path.clone(),
			relative_path: path.to_string_lossy().to_string(),
		})
		.collect();
	let result = match search_file_list(
		pattern,
		files,
		false,
		false,
		SearchParams {
			context_before: 0,
			context_after:  0,
			max_columns:    None,
			mode:           pi_text_search::OutputMode::Content,
			max_count:      None,
			offset:         0,
		},
		pi_text_search::DEFAULT_MAX_FILE_BYTES,
	) {
		Ok(result) => result,
		Err(err) => {
			return vec![NodeRef {
				locator:     "<text-search>".to_string(),
				range:       0..0,
				kind:        "§error".to_string(),
				content:     None,
				metadata:    HashMap::new(),
				diagnostics: vec![Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: err.to_string(),
					span:    None,
				}],
			}];
		},
	};
	let mut nodes = Vec::with_capacity(result.matches.len());
	for matched in result.matches {
		if cancel.is_cancelled() {
			break;
		}
		let start = matched.absolute_byte_offset as usize;
		let end = start.saturating_add(matched.line.len());
		let mut metadata = HashMap::new();
		metadata.insert("line".to_string(), serde_json::Value::Number(matched.line_number.into()));
		metadata.insert("shape".to_string(), serde_json::Value::String("match".to_string()));
		if matched.truncated {
			metadata.insert("truncated".to_string(), serde_json::Value::Bool(true));
		}
		nodes.push(NodeRef {
			locator: format!("{}::<line {}>", matched.path, matched.line_number),
			range: start..end,
			kind: "§line".to_string(),
			content: Some(Content::Text { value: matched.line }),
			metadata,
			diagnostics: Vec::new(),
		});
	}
	nodes
}
fn apply_step(content: &[u8], step: &Step, path: &std::path::Path) -> Vec<NodeRef> {
	let mut nodes = match &step.head {
		Head::NodeKind(kind) => match kind.as_str() {
			"line" => axes::line_steps(content, step),
			"para" => axes::para_steps(content, step),
			"chunk" => axes::chunk_steps(content, step),
			_ => axes::line_steps(content, step),
		},
		_ => axes::line_steps(content, step),
	};
	for n in &mut nodes {
		n.locator = format!("{}::{}", path.to_string_lossy(), n.locator);
	}
	// FEAT-719: mark predicate-matched §line nodes so the renderer can switch to
	// grep -n shape. Pure ordinal/range queries leave shape unset; FEAT-716 may
	// add `shape=slice` for sliced bodies.
	if matches!(&step.head, Head::NodeKind(k) if k == "line") {
		let is_match = step.predicates.iter().any(|p| {
			matches!(
				p,
				Predicate::TextMatch(_) | Predicate::LiteralMatch(_) | Predicate::Compare { .. }
			)
		});
		if is_match {
			for n in &mut nodes {
				n.metadata
					.insert("shape".to_string(), serde_json::Value::String("match".to_string()));
			}
		}
	}
	nodes
}

/// Expand context for `<<` or `>>` combinators.
///
/// `is_next` = true for `>>` (trailing), false for `<<` (leading).
fn expand_context(
	nodes: &[NodeRef],
	step: &Step,
	_file_paths: &[PathBuf],
	cancel: &CancellationToken,
	is_next: bool,
) -> Vec<NodeRef> {
	let count = context_count(step);
	if count == 0 {
		return nodes.to_vec();
	}

	let mut result = nodes.to_vec();

	for node in nodes {
		if cancel.is_cancelled() {
			break;
		}
		let (path_str, inner_locator) = node.locator.split_once("::").unwrap_or(("", &node.locator));
		let path = PathBuf::from(path_str);
		let content = match std::fs::read(&path) {
			Ok(c) => c,
			Err(_) => continue,
		};
		let idx = line_index::LineIndex::build(&content);
		let line_count = idx.line_count();

		let line_num = parse_line_num(inner_locator);
		let Some(line_num) = line_num else { continue };

		let start_line = if is_next {
			line_num + 1
		} else {
			line_num.saturating_sub(count)
		};
		let end_line = if is_next {
			(line_num + count).min(line_count)
		} else {
			line_num.saturating_sub(1)
		};

		if start_line == 0 || start_line > end_line {
			continue;
		}

		let text = String::from_utf8_lossy(&content);
		for ln in start_line..=end_line {
			let range = idx.line_range(ln, content.len()).unwrap_or(0..0);
			let line_text = text[range.clone()].to_string();
			let mut metadata = HashMap::new();
			metadata.insert("line".to_string(), serde_json::Value::Number(ln.into()));
			let ctx_node = NodeRef {
				locator: format!("{}::<line {ln}>", path_str),
				range,
				kind: "§line".to_string(),
				content: Some(Content::Text { value: line_text }),
				metadata,
				diagnostics: Vec::new(),
			};
			if !result
				.iter()
				.any(|n| n.locator == ctx_node.locator && n.range == ctx_node.range)
			{
				result.push(ctx_node);
			}
		}
	}

	result
}

fn context_count(step: &Step) -> usize {
	for pred in &step.predicates {
		if let Predicate::Range { end, .. } = pred {
			return end.unwrap_or(0).max(0) as usize;
		}
	}
	0
}

fn parse_line_num(locator: &str) -> Option<usize> {
	let s = locator.strip_prefix("<line ")?;
	let s = s.strip_suffix(">")?;
	// Plain `<line N>` since PLAN-317 dropped LINE#ID anchors; tolerate a
	// stray `#suffix` from older callers/snapshots.
	s.split('#').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
	use winnow::{Parser, token::take_while};

	use super::*;
	use crate::{
		ast::{Axis, Head, Predicate, Query},
		dialect::NameLexer,
		parser::parse_code_path,
	};

	struct DummyLexer;
	impl NameLexer for DummyLexer {
		fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<crate::ast::NamePayload> {
			let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
				.parse_next(input)?;
			Ok(crate::ast::NamePayload::Raw(s.to_string()))
		}

		fn render(&self, n: &crate::ast::NamePayload) -> String {
			match n {
				crate::ast::NamePayload::Raw(s) => s.clone(),
				crate::ast::NamePayload::Quoted(s) => s.clone(),
			}
		}

		fn matches(
			&self,
			_n: &crate::ast::NamePayload,
			_node: tree_sitter::Node<'_>,
			_src: &str,
		) -> bool {
			false
		}
	}

	fn make_resolver(root: PathBuf) -> TextResolver {
		TextResolver::new(root)
	}

	#[test]
	fn resolve_line_slice() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::§line[2..3]", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].locator.ends_with("<line 2..3>"), "{}", nodes[0].locator);
		let body = match nodes[0].content.as_ref().unwrap() {
			crate::types::Content::Text { value } => value.as_str(),
			_ => panic!("slice node must be Text"),
		};
		assert_eq!(body, "l2\nl3\n");
	}

	#[test]
	fn resolve_text_match() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"foo\nbar\nbaz\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path(r#"a.txt::§line[text~="ba."]"#, &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 2);
		assert!(nodes[0].locator.contains("<line 2>"));
		assert!(nodes[1].locator.contains("<line 3>"));
	}

	#[test]
	fn resolve_qualifier_raw() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"hello world").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::§line[1]#raw", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].content, Some(Content::Text { value: "hello world".to_string() }));
	}

	#[test]
	fn resolve_trailing_context_combinator() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\nl5\n").unwrap();

		let resolver = make_resolver(root.clone());
		// §line[text~="l2"]>>§line[0..2]
		let cp = CodePath {
			locator:   crate::ast::Locator::Fs(crate::ast::FsLocator {
				segments: vec![crate::ast::FsSegment::Literal("a.txt".to_string())],
			}),
			query:     Some(Query {
				head:  Step {
					axis:       Some(Axis::Structural),
					head:       Head::NodeKind("line".to_string()),
					predicates: vec![Predicate::TextMatch(r"l2".to_string())],
				},
				chain: vec![(Combinator::NextSibling, Step {
					axis:       Some(Axis::Structural),
					head:       Head::NodeKind("line".to_string()),
					predicates: vec![Predicate::Range { start: Some(0), end: Some(2) }],
				})],
			}),
			qualifier: None,
		};
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		// match line 2 + 2 trailing context lines (3,4) = 3 total
		assert_eq!(nodes.len(), 3);
		let locs: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		assert!(locs.iter().any(|l| l.contains("<line 2>")));
		assert!(locs.iter().any(|l| l.contains("<line 3>")));
		assert!(locs.iter().any(|l| l.contains("<line 4>")));
	}

	#[test]
	fn resolve_leading_context_combinator() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\nl5\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = CodePath {
			locator:   crate::ast::Locator::Fs(crate::ast::FsLocator {
				segments: vec![crate::ast::FsSegment::Literal("a.txt".to_string())],
			}),
			query:     Some(Query {
				head:  Step {
					axis:       Some(Axis::Structural),
					head:       Head::NodeKind("line".to_string()),
					predicates: vec![Predicate::TextMatch(r"l4".to_string())],
				},
				chain: vec![(Combinator::PrevSibling, Step {
					axis:       Some(Axis::Structural),
					head:       Head::NodeKind("line".to_string()),
					predicates: vec![Predicate::Range { start: Some(0), end: Some(2) }],
				})],
			}),
			qualifier: None,
		};
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		// match line 4 + 2 leading context lines (2,3) = 3 total
		assert_eq!(nodes.len(), 3);
		let locs: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		assert!(locs.iter().any(|l| l.contains("<line 2>")));
		assert!(locs.iter().any(|l| l.contains("<line 3>")));
		assert!(locs.iter().any(|l| l.contains("<line 4>")));
	}

	#[test]
	fn resolve_no_query_returns_files() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"x").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].kind, "§file");
	}

	#[test]
	fn resolve_empty_file_returns_no_lines() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("empty.txt"), b"").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("empty.txt::§line", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 0);
	}

	#[test]
	fn resolve_para_axis() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"p1\n\np2\n\np3\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::§para", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 3);
		assert!(nodes[0].locator.contains("<para 1>"));
	}

	#[test]
	fn resolve_chunk_axis() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let lines: String = (1..=100).map(|i| format!("{i}\n")).collect();
		std::fs::write(root.join("a.txt"), lines).unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::§chunk[n=25]", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 4);
		assert!(nodes[0].locator.contains("<chunk 1>"));
	}

	#[test]
	fn resolve_cancellation() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..10 {
			std::fs::write(root.join(format!("{i}.txt")), b"a\n").unwrap();
		}

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("*.txt::§line", &DummyLexer).unwrap();
		let cancel = CancellationToken::new();
		cancel.cancel();
		let nodes = resolver.resolve(&cp, &cancel).unwrap();
		assert!(nodes.len() < 10);
	}

	#[test]
	fn render_shape_match_metadata_set_for_text_match() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"alpha\nbeta useState\ngamma useState\ndelta\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::\u{a7}line[text~=\"useState\"]", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 2);
		for n in &nodes {
			assert_eq!(
				n.metadata.get("shape"),
				Some(&serde_json::Value::String("match".to_string())),
				"shape=match should be set on text-match \u{a7}line nodes",
			);
		}
	}

	#[test]
	fn render_shape_match_metadata_set_for_literal_match() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"alpha\nfoo TODO bar\nbaz\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp = parse_code_path("a.txt::\u{a7}line[match=\"TODO\"]", &DummyLexer).unwrap();
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(
			nodes[0].metadata.get("shape"),
			Some(&serde_json::Value::String("match".to_string())),
		);
	}

	#[test]
	fn render_shape_absent_for_ordinal_and_range() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\n").unwrap();

		let resolver = make_resolver(root.clone());
		let cp_ord = parse_code_path("a.txt::\u{a7}line[2]", &DummyLexer).unwrap();
		let ordinal_nodes = resolver
			.resolve(&cp_ord, &CancellationToken::new())
			.unwrap();
		for n in &ordinal_nodes {
			assert!(n.metadata.get("shape").is_none(), "ordinal must not carry shape metadata");
		}

		let cp_range = parse_code_path("a.txt::\u{a7}line[2..3]", &DummyLexer).unwrap();
		let range_nodes = resolver
			.resolve(&cp_range, &CancellationToken::new())
			.unwrap();
		for n in &range_nodes {
			assert!(
				n.metadata.get("shape").is_none()
					|| n.metadata.get("shape") == Some(&serde_json::Value::String("slice".to_string())),
				"range must not carry shape=match (FEAT-716 may set shape=slice)"
			);
		}
	}
}
