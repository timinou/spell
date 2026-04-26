use std::{collections::HashMap, env, fmt::Write as _, fs, path::Path};

use serde::Deserialize;

#[derive(Deserialize)]
struct NodeType {
	r#type:   String,
	named:    bool,
	#[serde(default)]
	fields:   HashMap<String, FieldInfo>,
	#[serde(default)]
	children: Option<ChildrenInfo>,
	#[serde(default)]
	subtypes: Option<Vec<SubType>>,
}

#[derive(Deserialize)]
struct FieldInfo {
	#[allow(dead_code, reason = "required for deserialization")]
	multiple: bool,
	#[allow(dead_code, reason = "required for deserialization")]
	required: bool,
	types:    Vec<SubType>,
}

#[derive(Deserialize)]
struct ChildrenInfo {
	#[allow(dead_code, reason = "required for deserialization")]
	multiple: bool,
	#[allow(dead_code, reason = "required for deserialization")]
	required: bool,
	types:    Vec<SubType>,
}

#[derive(Deserialize)]
struct SubType {
	r#type: String,
	named:  bool,
}

struct GrammarSource {
	/// Name used for the output file: grammar_{name}.rs
	name:            &'static str,
	/// Cargo dependency name used to resolve the selected registry version, if
	/// any.
	dependency_name: Option<&'static str>,
	/// Path to node-types source relative to crate source in the cargo registry.
	/// For vendored grammars this points at the embedded `NODE_TYPES` source in
	/// lib.rs. For registry crates we still resolve the installed crate dir and
	/// read the embedded node-types file from there.
	package_prefix:  &'static str,
	/// Sub-path within the crate directory to find node-types source.
	json_subpath:    &'static str,
}

const GRAMMARS: &[GrammarSource] = &[
	GrammarSource {
		name:            "typescript",
		dependency_name: Some("tree-sitter-typescript"),
		package_prefix:  "tree-sitter-typescript-",
		json_subpath:    "typescript/src/node-types.json",
	},
	GrammarSource {
		name:            "rust",
		dependency_name: Some("tree-sitter-rust"),
		package_prefix:  "tree-sitter-rust-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "python",
		dependency_name: Some("tree-sitter-python"),
		package_prefix:  "tree-sitter-python-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "html",
		dependency_name: Some("tree-sitter-html"),
		package_prefix:  "tree-sitter-html-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "css",
		dependency_name: Some("tree-sitter-css"),
		package_prefix:  "tree-sitter-css-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "typst",
		dependency_name: Some("codebook-tree-sitter-typst"),
		package_prefix:  "codebook-tree-sitter-typst-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "elixir",
		dependency_name: Some("tree-sitter-elixir"),
		package_prefix:  "tree-sitter-elixir-",
		json_subpath:    "src/node-types.json",
	},
	GrammarSource {
		name:            "clojure",
		dependency_name: Some("tree-sitter-clojure"),
		package_prefix:  "tree-sitter-clojure-",
		json_subpath:    "grammar-src/src/node-types.json",
	},
	GrammarSource {
		name:            "markdown",
		dependency_name: Some("tree-sitter-md"),
		package_prefix:  "tree-sitter-md-",
		json_subpath:    "tree-sitter-markdown/src/node-types.json",
	},
	GrammarSource {
		name:            "org",
		dependency_name: Some("tree-sitter-org"),
		package_prefix:  "tree-sitter-org-",
		json_subpath:    "src/node-types.json",
	},
];

fn main() {
	let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
	println!("cargo:rerun-if-changed=Cargo.toml");

	for grammar in GRAMMARS {
		match find_and_generate(grammar, &out_dir) {
			Ok(()) => {},
			Err(e) => {
				println!("cargo:warning=Failed to generate rules for {}: {e}", grammar.name);
				generate_empty(&out_dir, grammar.name);
			},
		}
	}
}

fn find_and_generate(grammar: &GrammarSource, out_dir: &str) -> Result<(), String> {
	let json_path = find_node_types_json(grammar)?;
	let content = fs::read_to_string(&json_path)
		.map_err(|e| format!("failed to read {}: {e}", json_path.display()))?;
	let node_types: Vec<NodeType> =
		serde_json::from_str(&content).map_err(|e| format!("failed to parse JSON: {e}"))?;

	let code = generate_grammar_module(&node_types);
	let out_path = Path::new(out_dir).join(format!("grammar_{}.rs", grammar.name));
	fs::write(&out_path, code)
		.map_err(|e| format!("failed to write {}: {e}", out_path.display()))?;

	println!("cargo:rerun-if-changed={}", json_path.display());

	Ok(())
}

fn find_node_types_json(grammar: &GrammarSource) -> Result<std::path::PathBuf, String> {
	if grammar.name == "org" {
		return Ok(
			Path::new(env!("CARGO_MANIFEST_DIR")).join("../tree-sitter-org/src/node-types.json")
		);
	}

	// Strategy: scan cargo registry src directories for the matching crate prefix.
	let home = env::var("CARGO_HOME")
		.or_else(|_| env::var("HOME").map(|h| format!("{h}/.cargo")))
		.map_err(|_| "cannot determine CARGO_HOME".to_string())?;

	let registry_src = Path::new(&home).join("registry/src");
	if !registry_src.exists() {
		return Err(format!("cargo registry not found at {}", registry_src.display()));
	}

	let selected_version = grammar
		.dependency_name
		.and_then(selected_dependency_version);

	for entry in fs::read_dir(&registry_src)
		.map_err(|e| format!("cannot read registry: {e}"))?
		.flatten()
	{
		let index_dir = entry.path();
		if !index_dir.is_dir() {
			continue;
		}

		if let Some(candidate) =
			find_registry_candidate(&index_dir, grammar, selected_version.as_deref())?
		{
			return Ok(candidate);
		}
	}

	Err(format!(
		"node-types.json not found for {} (searched {})",
		grammar.name,
		registry_src.display()
	))
}

fn selected_dependency_version(dep_name: &str) -> Option<String> {
	let manifest_dir_value = env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
	let manifest_dir = Path::new(&manifest_dir_value);
	let manifest_path = manifest_dir.join("Cargo.toml");
	find_lockfile(manifest_dir)
		.and_then(|lockfile| lock_dependency_version(&lockfile, dep_name))
		.or_else(|| manifest_dependency_version(manifest_path.as_path(), dep_name))
}

fn find_lockfile(manifest_dir: &Path) -> Option<std::path::PathBuf> {
	manifest_dir
		.ancestors()
		.map(|dir| dir.join("Cargo.lock"))
		.find(|candidate| candidate.exists())
}

fn lock_dependency_version(lockfile: &Path, dep_name: &str) -> Option<String> {
	let content = fs::read_to_string(lockfile).ok()?;
	let mut current_name: Option<String> = None;
	let mut current_version: Option<String> = None;
	let mut in_package = false;

	for raw_line in content.lines() {
		let line = strip_toml_comment(raw_line).trim();
		if line.is_empty() {
			continue;
		}

		if line.starts_with('[') {
			if line == "[[package]]" {
				if current_name.as_deref() == Some(dep_name) {
					return current_version;
				}
				current_name = None;
				current_version = None;
				in_package = true;
			} else {
				in_package = false;
			}
			continue;
		}

		if !in_package {
			continue;
		}

		if let Some((key, value)) = split_toml_key_value(line) {
			match key {
				"name" => current_name = extract_toml_string(value),
				"version" => current_version = extract_toml_string(value),
				_ => {},
			}
		}
	}

	if current_name.as_deref() == Some(dep_name) {
		return current_version;
	}

	None
}

fn manifest_dependency_version(manifest: &Path, dep_name: &str) -> Option<String> {
	let content = fs::read_to_string(manifest).ok()?;
	let mut in_dependencies = false;
	let mut current_table_dep: Option<&str> = None;

	for raw_line in content.lines() {
		let line = strip_toml_comment(raw_line).trim();
		if line.is_empty() {
			continue;
		}

		if let Some(table_name) = parse_toml_table_name(line) {
			in_dependencies = table_name == "dependencies";
			current_table_dep = table_name.strip_prefix("dependencies.");
			continue;
		}

		if let Some((key, value)) = split_toml_key_value(line) {
			if in_dependencies
				&& key == dep_name
				&& let Some(version) = extract_dependency_version(value)
			{
				return Some(version);
			}

			if current_table_dep == Some(dep_name)
				&& key == "version"
				&& let Some(version) = extract_toml_string(value)
			{
				return Some(version);
			}
		}
	}

	None
}

fn find_registry_candidate(
	index_dir: &Path,
	grammar: &GrammarSource,
	selected_version: Option<&str>,
) -> Result<Option<std::path::PathBuf>, String> {
	let crate_entries =
		fs::read_dir(index_dir).map_err(|e| format!("cannot read index dir: {e}"))?;
	let mut fallback = None;
	let exact_suffix = selected_version.map(|version| format!("-{version}"));

	for crate_entry in crate_entries.flatten() {
		let name = crate_entry.file_name();
		let name_str = name.to_string_lossy();
		if !name_str.starts_with(grammar.package_prefix) {
			continue;
		}

		let candidate = crate_entry.path().join(grammar.json_subpath);
		if !candidate.exists() {
			continue;
		}

		if let Some(exact_suffix) = exact_suffix.as_deref()
			&& name_str.ends_with(exact_suffix)
		{
			return Ok(Some(candidate));
		}

		if fallback.is_none() {
			fallback = Some(candidate);
		}
	}

	Ok(fallback)
}

fn parse_toml_table_name(line: &str) -> Option<&str> {
	let line = line.strip_prefix('[')?.strip_suffix(']')?.trim();
	if line.starts_with('[') {
		return None;
	}
	Some(line)
}

fn split_toml_key_value(line: &str) -> Option<(&str, &str)> {
	let mut parts = line.splitn(2, '=');
	let key = parts.next()?.trim();
	let value = parts.next()?.trim();
	if key.is_empty() || value.is_empty() {
		return None;
	}
	Some((key, value))
}

fn extract_dependency_version(value: &str) -> Option<String> {
	if value.starts_with('"') {
		return extract_toml_string(value);
	}

	if value.starts_with('{') {
		let mut search = value;
		while let Some(version_index) = search.find("version") {
			search = &search[version_index + "version".len()..];
			let search = search.trim_start();
			let search = search.strip_prefix('=')?.trim_start();
			if let Some(version) = extract_toml_string(search) {
				return Some(version);
			}
		}
	}

	None
}

fn extract_toml_string(value: &str) -> Option<String> {
	let mut chars = value.chars();
	if chars.next()? != '"' {
		return None;
	}

	let mut result = String::new();
	let mut escaped = false;
	for ch in chars {
		if escaped {
			result.push(ch);
			escaped = false;
			continue;
		}
		match ch {
			'\\' => escaped = true,
			'"' => return Some(result),
			_ => result.push(ch),
		}
	}

	None
}

fn strip_toml_comment(line: &str) -> &str {
	let mut in_string = false;
	let mut escaped = false;
	for (idx, ch) in line.char_indices() {
		if escaped {
			escaped = false;
			continue;
		}
		match ch {
			'\\' if in_string => escaped = true,
			'"' => in_string = !in_string,
			'#' if !in_string => return &line[..idx],
			_ => {},
		}
	}
	line
}

fn generate_grammar_module(node_types: &[NodeType]) -> String {
	let mut code = String::with_capacity(64 * 1024);

	writeln!(code, "// Generated by build.rs from tree-sitter node-types.json").unwrap();
	writeln!(code, "// DO NOT EDIT").unwrap();
	writeln!(code).unwrap();

	writeln!(
		code,
		"#[allow(unused_mut, clippy::field_reassign_with_default, clippy::vec_init_then_push, \
		 clippy::too_many_lines, reason = \"generated code\")]"
	)
	.unwrap();
	writeln!(code, "pub fn grammar() -> GeneratedGrammar {{").unwrap();
	writeln!(code, "\tlet mut production_rules = HashMap::new();").unwrap();
	writeln!(code, "\tlet mut inverse_rules: HashMap<String, Vec<String>> = HashMap::new();")
		.unwrap();
	writeln!(code, "\tlet mut all_types = Vec::new();").unwrap();
	writeln!(code, "\tlet mut supertypes = Vec::new();").unwrap();
	writeln!(code).unwrap();

	for nt in node_types {
		if !nt.named {
			continue;
		}

		writeln!(code, "\tall_types.push({:?}.to_string());", nt.r#type).unwrap();

		if let Some(subtypes) = &nt.subtypes {
			writeln!(code, "\tsupertypes.push({:?}.to_string());", nt.r#type).unwrap();
			for st in subtypes {
				if st.named {
					writeln!(
						code,
						"\tinverse_rules.entry({:?}.to_string()).or_default().push({:?}.to_string());",
						st.r#type, nt.r#type
					)
					.unwrap();
				}
			}
			continue;
		}

		if nt.fields.is_empty() && nt.children.is_none() {
			continue;
		}

		writeln!(code, "\t{{").unwrap();
		writeln!(code, "\t\tlet mut rule = ProductionRule::default();").unwrap();

		for (field_name, field_info) in &nt.fields {
			let child_types: Vec<&str> = field_info
				.types
				.iter()
				.filter(|t| t.named)
				.map(|t| t.r#type.as_str())
				.collect();
			if !child_types.is_empty() {
				writeln!(
					code,
					"\t\trule.fields.insert({field_name:?}.to_string(), vec![{}]);",
					child_types
						.iter()
						.map(|t| format!("{t:?}.to_string()"))
						.collect::<Vec<_>>()
						.join(", ")
				)
				.unwrap();
				for ct in &child_types {
					writeln!(
						code,
						"\t\tinverse_rules.entry({ct:?}.to_string()).or_default().push({:?}.\
						 to_string());",
						nt.r#type
					)
					.unwrap();
				}
			}
		}

		if let Some(children) = &nt.children {
			let child_types: Vec<&str> = children
				.types
				.iter()
				.filter(|t| t.named)
				.map(|t| t.r#type.as_str())
				.collect();
			if !child_types.is_empty() {
				writeln!(
					code,
					"\t\trule.unnamed_children = vec![{}];",
					child_types
						.iter()
						.map(|t| format!("{t:?}.to_string()"))
						.collect::<Vec<_>>()
						.join(", ")
				)
				.unwrap();
			}
		}

		writeln!(code, "\t\tproduction_rules.insert({:?}.to_string(), rule);", nt.r#type).unwrap();
		writeln!(code, "\t}}").unwrap();
	}

	writeln!(code).unwrap();
	writeln!(code, "\tfor parents in inverse_rules.values_mut() {{").unwrap();
	writeln!(code, "\t\tparents.sort();").unwrap();
	writeln!(code, "\t\tparents.dedup();").unwrap();
	writeln!(code, "\t}}").unwrap();
	writeln!(code).unwrap();
	writeln!(
		code,
		"\tGeneratedGrammar {{ production_rules, inverse_rules, all_types, supertypes }}"
	)
	.unwrap();
	writeln!(code, "}}").unwrap();

	code
}

fn generate_empty(out_dir: &str, name: &str) {
	let code = r"// Generated by build.rs — grammar not found, empty fallback
// DO NOT EDIT

pub fn grammar() -> GeneratedGrammar {
	GeneratedGrammar {
		production_rules: HashMap::new(),
		inverse_rules: HashMap::new(),
		all_types: Vec::new(),
		supertypes: Vec::new(),
	}
}";
	let out_path = Path::new(out_dir).join(format!("grammar_{name}.rs"));
	fs::write(out_path, code).ok();
}
