//! KDL parser + layered loader for the `semantic {}` configuration block.
//!
//! ## Layering precedence (highest first)
//!
//! 1. `<project>/.spell/config.kdl` — per-project overrides
//! 2. `~/.spell/config.kdl` — per-user defaults
//! 3. Compiled-in `defaults.kdl` (this crate, included via `include_str!`)
//!
//! Merge semantics: a higher-priority layer's per-language and per-server
//! entries replace the lower-priority entry of the same name; the rest of
//! the block's scalar settings are taken from the highest layer that
//! defined them.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	time::Duration,
};

use kdl::{KdlDocument, KdlNode, KdlValue};
use serde_json::Value;

use crate::semantic::lsp::ServerSpec;

/// Top-level parsed configuration.
#[derive(Debug, Clone)]
pub struct SemanticConfig {
	pub idle_ttl:           Duration,
	pub max_warm_servers:   usize,
	pub request_timeout:    Duration,
	pub sync_debounce:      Duration,
	pub bm25_incremental:   bool,
	pub language_backends:  HashMap<String, LanguageBackendConfig>,
	pub server_specs:       HashMap<String, ServerSpec>,
}

impl Default for SemanticConfig {
	fn default() -> Self {
		Self {
			idle_ttl:           Duration::from_secs(1800),
			max_warm_servers:   6,
			request_timeout:    Duration::from_secs(5),
			sync_debounce:      Duration::from_millis(50),
			bm25_incremental:   true,
			language_backends:  HashMap::new(),
			server_specs:       HashMap::new(),
		}
	}
}

/// Per-language wiring. `lsp = Some(name)` references a server registered
/// in `SemanticConfig::server_specs`; `None` means tree-sitter / annotation
/// backend only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageBackendConfig {
	pub language: String,
	pub lsp:      Option<String>,
}

#[derive(Debug)]
pub enum ConfigError {
	ParseError(String),
	MissingField { node: String, field: String },
	BadValue { node: String, message: String },
	UnknownServerRef { language: String, server: String },
	Io(std::io::Error),
}

impl std::fmt::Display for ConfigError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::ParseError(s) => write!(f, "KDL parse error: {s}"),
			Self::MissingField { node, field } => write!(f, "node `{node}` missing required field `{field}`"),
			Self::BadValue { node, message } => write!(f, "node `{node}`: {message}"),
			Self::UnknownServerRef { language, server } => write!(
				f,
				"language \"{language}\" references unknown server \"{server}\""
			),
			Self::Io(e) => write!(f, "config io error: {e}"),
		}
	}
}
impl std::error::Error for ConfigError {}

/// Compiled-in defaults shipped with the crate.
pub const COMPILED_DEFAULTS: &str = include_str!("defaults.kdl");

impl SemanticConfig {
	/// Parse a KDL document and extract the top-level `semantic { ... }`
	/// block. Returns `Default` when the document is empty or contains no
	/// `semantic` node.
	pub fn parse(input: &str) -> Result<Self, ConfigError> {
		let doc: KdlDocument = input
			.parse()
			.map_err(|e: kdl::KdlError| ConfigError::ParseError(format!("{e:?}")))?;
		let Some(semantic) = doc.nodes().iter().find(|n| n.name().value() == "semantic") else {
			return Ok(Self::default());
		};
		let mut cfg = Self::default();
		let Some(children) = semantic.children() else {
			return Ok(cfg);
		};
		for node in children.nodes() {
			match node.name().value() {
				"idle-ttl-secs"       => cfg.idle_ttl        = Duration::from_secs(read_u64(node)?),
				"max-warm-servers"    => cfg.max_warm_servers = read_u64(node)? as usize,
				"request-timeout-ms"  => cfg.request_timeout = Duration::from_millis(read_u64(node)?),
				"sync-debounce-ms"    => cfg.sync_debounce   = Duration::from_millis(read_u64(node)?),
				"bm25" => parse_bm25(node, &mut cfg)?,
				"language" => parse_language(node, &mut cfg)?,
				"server" => parse_server(node, &mut cfg)?,
				_ => {} // unknown nodes ignored for forward-compat
			}
		}
		Ok(cfg)
	}

	/// Build from the compiled-in defaults.kdl. Infallible — a panic here
	/// indicates a bug in the bundled defaults file.
	pub fn defaults() -> Self {
		Self::parse(COMPILED_DEFAULTS).expect("compiled-in defaults.kdl must parse")
	}

	/// Validate references: every `language.lsp = Some(name)` must point at
	/// an entry in `server_specs`.
	pub fn validate(&self) -> Result<(), ConfigError> {
		for (lang, backend) in &self.language_backends {
			if let Some(server) = &backend.lsp {
				if !self.server_specs.contains_key(server) {
					return Err(ConfigError::UnknownServerRef {
						language: lang.clone(),
						server:   server.clone(),
					});
				}
			}
		}
		Ok(())
	}

	/// Merge `higher` on top of `lower`. Scalar settings on `higher` always
	/// win (no notion of "unset"); per-language and per-server entries from
	/// `higher` replace those of the same name in `lower`.
	pub fn merge(higher: Self, mut lower: Self) -> Self {
		// Scalars: higher wins.
		lower.idle_ttl = higher.idle_ttl;
		lower.max_warm_servers = higher.max_warm_servers;
		lower.request_timeout = higher.request_timeout;
		lower.sync_debounce = higher.sync_debounce;
		lower.bm25_incremental = higher.bm25_incremental;
		// Per-language: higher's entries override lower's same-keyed entries.
		for (k, v) in higher.language_backends {
			lower.language_backends.insert(k, v);
		}
		for (k, v) in higher.server_specs {
			lower.server_specs.insert(k, v);
		}
		lower
	}

	/// Load layered config: compiled defaults <- ~/.spell/config.kdl <-
	/// `<project>/.spell/config.kdl`. Missing files are skipped silently.
	pub fn load_layered(project_root: &Path) -> Result<Self, ConfigError> {
		let mut config = Self::defaults();

		if let Some(user_dir) = dirs::home_dir() {
			let user_path = user_dir.join(".spell").join("config.kdl");
			if let Ok(text) = std::fs::read_to_string(&user_path) {
				let user_cfg = Self::parse(&text)?;
				config = Self::merge(user_cfg, config);
			}
		}

		let project_path = project_root.join(".spell").join("config.kdl");
		if let Ok(text) = std::fs::read_to_string(&project_path) {
			let project_cfg = Self::parse(&text)?;
			config = Self::merge(project_cfg, config);
		}

		config.validate()?;
		Ok(config)
	}
}

// ── Per-node parsers ────────────────────────────────────────────────

fn parse_bm25(node: &KdlNode, cfg: &mut SemanticConfig) -> Result<(), ConfigError> {
	if let Some(children) = node.children() {
		for child in children.nodes() {
			if child.name().value() == "incremental" {
				cfg.bm25_incremental = read_bool(child)?;
			}
		}
	}
	Ok(())
}

fn parse_language(node: &KdlNode, cfg: &mut SemanticConfig) -> Result<(), ConfigError> {
	let language = read_positional_string(node, "language")?;
	let mut lsp: Option<String> = None;
	if let Some(children) = node.children() {
		for child in children.nodes() {
			if child.name().value() == "lsp" {
				lsp = Some(read_positional_string(child, "lsp")?);
			}
		}
	}
	cfg.language_backends.insert(
		language.clone(),
		LanguageBackendConfig { language, lsp },
	);
	Ok(())
}

fn parse_server(node: &KdlNode, cfg: &mut SemanticConfig) -> Result<(), ConfigError> {
	let name = read_positional_string(node, "server")?;
	let mut command = String::new();
	let mut args: Vec<String> = Vec::new();
	let mut file_extensions: Vec<String> = Vec::new();
	let mut root_markers: Vec<String> = Vec::new();
	let mut env: Vec<(String, String)> = Vec::new();
	let mut init_options: Option<Value> = None;
	let mut install_hint: Option<String> = None;
	let mut request_timeout = Duration::from_secs(5);

	if let Some(children) = node.children() {
		for child in children.nodes() {
			match child.name().value() {
				"command" => command = read_positional_string(child, "command")?,
				"args" => args = child
					.entries()
					.iter()
					.filter_map(|e| e.value().as_string().map(String::from))
					.collect(),
				"file-types" | "file_types" => {
					file_extensions = child
						.entries()
						.iter()
						.filter_map(|e| e.value().as_string().map(String::from))
						.collect();
				},
				"root-markers" | "root_markers" => {
					root_markers = child
						.entries()
						.iter()
						.filter_map(|e| e.value().as_string().map(String::from))
						.collect();
				},
				"env" => {
					if let Some(env_children) = child.children() {
						for env_node in env_children.nodes() {
							let key = env_node.name().value().to_string();
							let val = read_positional_string(env_node, &key)?;
							env.push((key, val));
						}
					}
				},
				"init-options" | "init_options" => {
					init_options = Some(node_to_json_value(child));
				},
				"install-hint" | "install_hint" => {
					install_hint = Some(read_positional_string(child, "install-hint")?);
				},
				"request-timeout-secs" | "request_timeout_secs" => {
					request_timeout = Duration::from_secs(read_u64(child)?);
				},
				_ => {}
			}
		}
	}

	if command.is_empty() {
		return Err(ConfigError::MissingField {
			node:  format!("server \"{name}\""),
			field: "command".into(),
		});
	}

	cfg.server_specs.insert(
		name.clone(),
		ServerSpec {
			name,
			command,
			args,
			file_extensions,
			root_markers,
			env,
			init_options,
			install_hint,
			request_timeout,
		},
	);
	Ok(())
}

// ── KdlValue helpers ────────────────────────────────────────────────

fn read_positional_string(node: &KdlNode, field: &str) -> Result<String, ConfigError> {
	node.entries()
		.first()
		.and_then(|e| e.value().as_string().map(String::from))
		.ok_or_else(|| ConfigError::MissingField {
			node:  node.name().value().to_string(),
			field: field.into(),
		})
}

fn read_u64(node: &KdlNode) -> Result<u64, ConfigError> {
	let v = node.entries().first().ok_or_else(|| ConfigError::MissingField {
		node:  node.name().value().to_string(),
		field: "value".into(),
	})?;
	v.value().as_integer().and_then(|i| u64::try_from(i).ok())
		.ok_or_else(|| ConfigError::BadValue {
			node:    node.name().value().to_string(),
			message: format!("expected u64, got {:?}", v.value()),
		})
}

fn read_bool(node: &KdlNode) -> Result<bool, ConfigError> {
	let v = node.entries().first().ok_or_else(|| ConfigError::MissingField {
		node:  node.name().value().to_string(),
		field: "value".into(),
	})?;
	v.value().as_bool().ok_or_else(|| ConfigError::BadValue {
		node:    node.name().value().to_string(),
		message: format!("expected bool, got {:?}", v.value()),
	})
}

/// Convert a KdlNode's children to a serde_json::Value (for opaque
/// init-options pass-through). Mirrors a minimal subset of KDL → JSON.
fn node_to_json_value(node: &KdlNode) -> Value {
	let Some(children) = node.children() else {
		return Value::Null;
	};
	let mut map = serde_json::Map::new();
	for child in children.nodes() {
		let key = child.name().value().to_string();
		let value = if child.children().is_some() {
			node_to_json_value(child)
		} else if let Some(entry) = child.entries().first() {
			kdl_value_to_json(entry.value())
		} else {
			Value::Null
		};
		map.insert(key, value);
	}
	Value::Object(map)
}

fn kdl_value_to_json(v: &KdlValue) -> Value {
	match v {
		KdlValue::String(s) => Value::String(s.clone()),
		KdlValue::Integer(i) => Value::from(*i as i64),
		KdlValue::Float(f) => Value::from(*f),
		KdlValue::Bool(b) => Value::from(*b),
		KdlValue::Null => Value::Null,
	}
}

/// Re-export needed for the loader path.
pub(crate) use dirs as _dirs_dep;

#[cfg(test)]
mod tests {
	use super::*;

	const SAMPLE_KDL: &str = r#"
semantic {
    idle-ttl-secs       3600
    max-warm-servers       4
    request-timeout-ms 10000
    sync-debounce-ms     100
    bm25 { incremental #false }

    language "rust"    { lsp "rust-analyzer" }
    language "python"  { }

    server "rust-analyzer" {
        command "rust-analyzer"
        file-types ".rs"
        root-markers "Cargo.toml"
        request-timeout-secs 15
        env { CARGO_HOME "/tmp/cargo" }
        install-hint "rustup component add rust-analyzer"
    }
}
"#;

	#[test]
	fn parse_returns_default_for_empty_document() {
		let cfg = SemanticConfig::parse("").expect("empty parses");
		assert_eq!(cfg.max_warm_servers, 6);
		assert!(cfg.bm25_incremental);
		assert!(cfg.language_backends.is_empty());
		assert!(cfg.server_specs.is_empty());
	}

	#[test]
	fn parse_returns_default_when_no_semantic_block() {
		let cfg = SemanticConfig::parse("other-block { foo 1 }").expect("parses");
		assert_eq!(cfg, SemanticConfig::default_ignoring_maps());
	}

	#[test]
	fn parse_sample_extracts_scalars() {
		let cfg = SemanticConfig::parse(SAMPLE_KDL).expect("parses");
		assert_eq!(cfg.idle_ttl, Duration::from_secs(3600));
		assert_eq!(cfg.max_warm_servers, 4);
		assert_eq!(cfg.request_timeout, Duration::from_millis(10_000));
		assert_eq!(cfg.sync_debounce, Duration::from_millis(100));
		assert!(!cfg.bm25_incremental);
	}

	#[test]
	fn parse_sample_extracts_language_entries() {
		let cfg = SemanticConfig::parse(SAMPLE_KDL).expect("parses");
		assert_eq!(cfg.language_backends.len(), 2);
		assert_eq!(
			cfg.language_backends.get("rust").unwrap().lsp.as_deref(),
			Some("rust-analyzer")
		);
		assert!(cfg.language_backends.get("python").unwrap().lsp.is_none());
	}

	#[test]
	fn parse_sample_extracts_server_specs() {
		let cfg = SemanticConfig::parse(SAMPLE_KDL).expect("parses");
		let ra = cfg.server_specs.get("rust-analyzer").expect("ra spec present");
		assert_eq!(ra.command, "rust-analyzer");
		assert_eq!(ra.file_extensions, vec![".rs".to_string()]);
		assert_eq!(ra.root_markers, vec!["Cargo.toml".to_string()]);
		assert_eq!(ra.request_timeout, Duration::from_secs(15));
		assert_eq!(ra.install_hint.as_deref(), Some("rustup component add rust-analyzer"));
		assert_eq!(ra.env, vec![("CARGO_HOME".to_string(), "/tmp/cargo".to_string())]);
	}

	#[test]
	fn defaults_compile_in_and_parse() {
		let cfg = SemanticConfig::defaults();
		assert!(
			cfg.language_backends.contains_key("elixir"),
			"defaults.kdl must wire Elixir"
		);
		assert_eq!(
			cfg.language_backends.get("elixir").unwrap().lsp.as_deref(),
			Some("expert")
		);
		let expert = cfg.server_specs.get("expert").expect("expert spec");
		assert_eq!(expert.command, "expert");
		assert_eq!(expert.args, vec!["--stdio".to_string()]);
		assert_eq!(
			expert.file_extensions,
			vec![".ex".to_string(), ".exs".to_string(), ".heex".to_string(), ".eex".to_string()]
		);
		assert!(
			expert.root_markers.contains(&"mix.exs".to_string()),
			"mix.exs marker present"
		);
		assert_eq!(
			expert.env,
			vec![("MIX_ENV".to_string(), "dev".to_string())]
		);
		cfg.validate().expect("defaults.kdl must validate");
	}

	#[test]
	fn validate_rejects_unknown_server_ref() {
		let bad = r#"
            semantic {
                language "rust" { lsp "ghost-server" }
                server "expert" { command "expert" }
            }
        "#;
		let cfg = SemanticConfig::parse(bad).expect("parses");
		let err = cfg.validate().unwrap_err();
		assert!(matches!(err, ConfigError::UnknownServerRef { .. }));
	}

	#[test]
	fn parse_rejects_server_without_command() {
		let bad = r#"
            semantic {
                server "broken" {
                    file-types ".rs"
                }
            }
        "#;
		let err = SemanticConfig::parse(bad).unwrap_err();
		assert!(matches!(err, ConfigError::MissingField { ref field, .. } if field == "command"));
	}

	#[test]
	fn merge_higher_priority_overrides_scalar_settings() {
		let mut lower = SemanticConfig::default();
		lower.max_warm_servers = 6;
		let mut higher = SemanticConfig::default();
		higher.max_warm_servers = 2;
		higher.request_timeout = Duration::from_secs(99);

		let merged = SemanticConfig::merge(higher, lower);
		assert_eq!(merged.max_warm_servers, 2);
		assert_eq!(merged.request_timeout, Duration::from_secs(99));
	}

	#[test]
	fn merge_replaces_per_language_entries_keeps_unmentioned() {
		let mut lower = SemanticConfig::default();
		lower.language_backends.insert(
			"rust".into(),
			LanguageBackendConfig { language: "rust".into(), lsp: Some("lower".into()) },
		);
		lower.language_backends.insert(
			"go".into(),
			LanguageBackendConfig { language: "go".into(), lsp: Some("gopls".into()) },
		);

		let mut higher = SemanticConfig::default();
		higher.language_backends.insert(
			"rust".into(),
			LanguageBackendConfig { language: "rust".into(), lsp: Some("higher".into()) },
		);

		let merged = SemanticConfig::merge(higher, lower);
		assert_eq!(
			merged.language_backends.get("rust").unwrap().lsp.as_deref(),
			Some("higher")
		);
		assert_eq!(
			merged.language_backends.get("go").unwrap().lsp.as_deref(),
			Some("gopls"),
			"unmentioned language preserved"
		);
	}

	#[test]
	fn load_layered_falls_back_to_defaults_when_no_files_exist() {
		let temp = tempfile::tempdir().unwrap();
		// HOME pointed at temp so ~/.spell/config.kdl doesn't exist.
		let old_home = std::env::var_os("HOME");
		unsafe {
			std::env::set_var("HOME", temp.path());
		}
		let result = SemanticConfig::load_layered(temp.path());
		if let Some(h) = old_home {
			unsafe { std::env::set_var("HOME", h); }
		}
		let cfg = result.expect("defaults must load");
		assert!(cfg.language_backends.contains_key("elixir"));
	}

	#[test]
	fn load_layered_project_overrides_defaults() {
		let temp = tempfile::tempdir().unwrap();
		let spell_dir = temp.path().join(".spell");
		std::fs::create_dir_all(&spell_dir).unwrap();
		let override_kdl = r#"
            semantic {
                max-warm-servers 2
                server "expert" {
                    command "my-expert"
                }
            }
        "#;
		std::fs::write(spell_dir.join("config.kdl"), override_kdl).unwrap();

		let old_home = std::env::var_os("HOME");
		unsafe {
			std::env::set_var("HOME", temp.path());
		}
		let result = SemanticConfig::load_layered(temp.path());
		if let Some(h) = old_home {
			unsafe { std::env::set_var("HOME", h); }
		}
		let cfg = result.expect("layered load");
		assert_eq!(cfg.max_warm_servers, 2, "project override wins");
		assert_eq!(
			cfg.server_specs.get("expert").unwrap().command,
			"my-expert",
			"project server entry replaces compiled-in"
		);
		// Language wiring inherited from defaults since override didn't redefine.
		assert!(cfg.language_backends.contains_key("elixir"));
	}

	#[test]
	fn parse_init_options_passes_through_as_json() {
		let input = r#"
            semantic {
                server "x" {
                    command "x"
                    init-options {
                        checkOnSave #true
                        cargo { allFeatures #false }
                    }
                }
            }
        "#;
		let cfg = SemanticConfig::parse(input).expect("parses");
		let x = cfg.server_specs.get("x").unwrap();
		let json = x.init_options.as_ref().unwrap();
		assert_eq!(json["checkOnSave"], Value::Bool(true));
		assert_eq!(json["cargo"]["allFeatures"], Value::Bool(false));
	}

	// Helper used by parse_returns_default_when_no_semantic_block to compare
	// only the scalar fields (HashMaps are PartialEq comparable; ServerSpec is
	// not). Provides a deterministic baseline.
	impl SemanticConfig {
		fn default_ignoring_maps() -> Self {
			Self::default()
		}
	}

	impl PartialEq for SemanticConfig {
		fn eq(&self, other: &Self) -> bool {
			self.idle_ttl == other.idle_ttl
				&& self.max_warm_servers == other.max_warm_servers
				&& self.request_timeout == other.request_timeout
				&& self.sync_debounce == other.sync_debounce
				&& self.bm25_incremental == other.bm25_incremental
				&& self.language_backends == other.language_backends
				&& self.server_specs.keys().collect::<std::collections::BTreeSet<_>>()
					== other.server_specs.keys().collect::<std::collections::BTreeSet<_>>()
		}
	}
}

