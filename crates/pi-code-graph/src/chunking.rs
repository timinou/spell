use std::{collections::BTreeMap, fs, path::Path};

use petgraph::visit::NodeIndexable;

use crate::model::{GraphNode, PersistedCodeGraph, SymbolKind, SymbolNode};

/// A contextualized code chunk ready for embedding.
#[derive(Debug, Clone)]
pub struct ChunkResult {
	/// Index of the symbol node in the graph.
	pub node_index: usize,
	/// Contextualized text including scope header + code body.
	pub text:       String,
}

/// Extract contextualized chunks for all symbols in the graph.
///
/// Reads source files from disk using the graph's root + symbol file paths.
/// Returns one chunk per symbol that has extractable code content.
///
/// `max_body_lines` controls how many lines of function body to include.
pub fn extract_chunks(
	graph: &PersistedCodeGraph,
	max_body_lines: usize,
) -> Result<Vec<ChunkResult>, std::io::Error> {
	// Group symbol node indices by file path so we read each file only once.
	let mut by_file: BTreeMap<&Path, Vec<(usize, &SymbolNode)>> = BTreeMap::new();
	for node_index in graph.graph.node_indices() {
		if let GraphNode::Symbol(symbol) = &graph.graph[node_index] {
			let idx = graph.graph.to_index(node_index);
			by_file
				.entry(symbol.file.as_path())
				.or_default()
				.push((idx, symbol));
		}
	}

	let mut chunks = Vec::new();

	for (relative_path, mut symbols) in by_file {
		// Sort symbols by line number for boundary detection.
		symbols.sort_by_key(|(_, s)| s.line);

		let abs_path = graph.root.join(relative_path);
		let source = match fs::read_to_string(&abs_path) {
			Ok(s) => s,
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
			Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue, // non-UTF-8
			Err(e) => return Err(e),
		};
		let lines: Vec<&str> = source.lines().collect();

		for (i, &(node_index, symbol)) in symbols.iter().enumerate() {
			let start_line = symbol.line.saturating_sub(1) as usize; // 1-indexed -> 0-indexed
			if start_line >= lines.len() {
				continue;
			}

			// End boundary: next symbol's start line or file end.
			let end_line = if i + 1 < symbols.len() {
				let next_start = symbols[i + 1].1.line.saturating_sub(1) as usize;
				next_start.min(lines.len())
			} else {
				lines.len()
			};

			// Clamp to max_body_lines.
			let end_line = end_line.min(start_line + max_body_lines);
			if end_line <= start_line {
				continue;
			}

			let body: String = lines[start_line..end_line].join("\n");
			if body.trim().is_empty() {
				continue;
			}

			let kind_label = symbol_kind_label(&symbol.kind);
			let header =
				format!("# {}\n# {}: {}", relative_path.display(), kind_label, symbol.qualified_name);
			let text = format!("{header}\n{body}");
			chunks.push(ChunkResult { node_index, text });
		}
	}

	Ok(chunks)
}

const fn symbol_kind_label(kind: &SymbolKind) -> &'static str {
	match kind {
		SymbolKind::Function => "Function",
		SymbolKind::Class => "Class",
		SymbolKind::Method => "Method",
		SymbolKind::Variable => "Variable",
		SymbolKind::Interface => "Interface",
		SymbolKind::TypeAlias => "TypeAlias",
		SymbolKind::Enum => "Enum",
		SymbolKind::Module => "Module",
		SymbolKind::Macro => "Macro",
		SymbolKind::Template => "Template",
	}
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{FileNode, GraphStats};

	fn make_graph(root: &Path, symbols: Vec<SymbolNode>) -> PersistedCodeGraph {
		let mut graph = StableGraph::new();
		for symbol in &symbols {
			graph.add_node(GraphNode::File(FileNode {
				path:     symbol.file.clone(),
				language: "typescript".into(),
			}));
		}
		for symbol in symbols {
			graph.add_node(GraphNode::Symbol(symbol));
		}
		PersistedCodeGraph {
			root: root.to_path_buf(),
			graph,
			stats: GraphStats::default(),
			generated_at_ms: 0,
			git_head: None,
		}
	}

	#[test]
	fn extract_chunks_includes_header_and_body() {
		let tmp = std::env::temp_dir().join(format!("pi-graph-chunk-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).unwrap();
		std::fs::write(
			tmp.join("foo.ts"),
			"export function greet(name: string): string {\n\treturn `Hello ${name}`;\n}\n",
		)
		.unwrap();

		let graph = make_graph(&tmp, vec![SymbolNode {
			name:           "greet".into(),
			qualified_name: "foo.ts::greet".into(),
			file:           PathBuf::from("foo.ts"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}]);

		let chunks = extract_chunks(&graph, 30).expect("extract_chunks");
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].text.contains("# foo.ts"), "header should contain file path");
		assert!(
			chunks[0].text.contains("# Function: foo.ts::greet"),
			"header should contain qualified name"
		);
		assert!(chunks[0].text.contains("export function greet"), "body should contain code");
		let _ = std::fs::remove_dir_all(&tmp);
	}

	#[test]
	fn extract_chunks_skips_missing_file() {
		let tmp = std::env::temp_dir().join(format!("pi-graph-missing-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).unwrap();

		let graph = make_graph(&tmp, vec![SymbolNode {
			name:           "gone".into(),
			qualified_name: "missing.ts::gone".into(),
			file:           PathBuf::from("missing.ts"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}]);

		let chunks = extract_chunks(&graph, 30).expect("extract_chunks");
		assert!(chunks.is_empty(), "should skip missing files gracefully");
		let _ = std::fs::remove_dir_all(&tmp);
	}

	#[test]
	fn extract_chunks_truncates_to_max_body_lines() {
		let tmp = std::env::temp_dir().join(format!("pi-graph-trunc-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).unwrap();
		let mut content = String::new();
		for i in 0..50 {
			content.push_str(&format!("const line{i} = {i};\n"));
		}
		std::fs::write(tmp.join("big.ts"), &content).unwrap();

		let graph = make_graph(&tmp, vec![SymbolNode {
			name:           "line0".into(),
			qualified_name: "big.ts::line0".into(),
			file:           PathBuf::from("big.ts"),
			kind:           SymbolKind::Variable,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}]);

		let chunks = extract_chunks(&graph, 5).expect("extract_chunks");
		assert_eq!(chunks.len(), 1);
		// Header is 2 lines, body is 5 lines.
		let line_count = chunks[0].text.lines().count();
		assert_eq!(line_count, 7, "should be 2 header lines + 5 body lines");
		let _ = std::fs::remove_dir_all(&tmp);
	}
}
