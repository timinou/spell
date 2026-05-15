//! Criterion benchmarks for CodePath hot paths.
//!
//! Run: `cargo bench -p pi-natives --bench codepath_bench`
//!
//! 1. `grep_todo_spell_repo`   — grep "TODO" across ~3K .rs files   (budget 500ms p95)
//! 2. `parse_codepath`         — parse 20 canonical paths × 50×     (budget 100µs each)
//! 3. `get_500line_file`       — resolve `§line[10..20]` on 500L    (budget 10ms)
//! 4. `resolve_50_symbols`     — resolve 50 symbols in a file       (budget 50ms total)
//! 5. `traverse_edges`         — edge traversal (ignored: no graph)  (budget —)

use std::{
	path::PathBuf,
	sync::Arc,
};

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ignore::WalkBuilder;
use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Axis, Head, NamePayload, Predicate, Query, Step},
	dialect::NameLexer,
	resolver::{CancellationToken, CodeResolver},
};
use pi_natives::code_path::code_resolver::CodeResolverImpl;
use tempfile::tempdir;
use winnow::{Parser, token::take_while};
use std::io::Write;

// ── Constants ────────────────────────────────────────────────────

/// Root of the spell repository for the grep benchmark.
///
/// `CARGO_MANIFEST_DIR` is the *crate* dir (`crates/pi-natives`). The grep
/// bench is named `grep_todo_spell_repo` because it should cover the whole
/// workspace, so we walk two levels up to the workspace root.
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

// ── Lexer ───────────────────────────────────────────────────────

/// Minimal NameLexer matching alphanumeric + dots (same as napi.rs DotLexer).
struct DotLexer;

impl NameLexer for DotLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
			.parse_next(input)?;
		Ok(NamePayload::Raw(s.to_string()))
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(
		&self,
		_n: &NamePayload,
		_node: tree_sitter::Node<'_>,
		_src: &str,
	) -> bool {
		false
	}
}

// ── Benchmark 1: grep "TODO" across spell repo ──────────────────
//
// Walks the spell repo using `ignore::WalkBuilder` (respects .gitignore),
// reads each .rs file, and counts lines containing "TODO". This mirrors
// the kernel's `§line[text~="TODO"]` evaluator which uses `str::contains`.

fn bench_grep_todo(c: &mut Criterion) {
	let root = PathBuf::from(REPO_ROOT);

	c.bench_function("grep_todo_spell_repo", |b| {
		b.iter(|| {
			let walker = WalkBuilder::new(&root)
				.standard_filters(true)
				.git_global(true)
				.git_ignore(true)
				.git_exclude(true)
				.build();
			let mut count: u64 = 0;
			for result in walker {
				let entry = match result {
					Ok(e) => e,
					Err(_) => continue,
				};
				if entry.path().extension().map_or(false, |e| e == "rs") {
					if let Ok(content) = std::fs::read_to_string(entry.path()) {
						let matching = content
							.lines()
							.filter(|line| line.contains("TODO"))
							.count() as u64;
						count += matching;
					}
				}
			}
			black_box(count);
		})
	});
}

// ── Benchmark 2: parseCodePath × 1000 ────────────────────────────
//
// Parse 20 canonical CodePath expressions 50× each = 1000 parses.
// Covers: bare file, file:slice, file::symbol, file::symbol#body,
// glob, URI, predicates, combinator chains.

fn bench_parse_codepath(c: &mut Criterion) {
	let inputs: Vec<&str> = vec![
		"src/api.ts",
		"foo.ts:50",
		"foo.ts:-25",
		"foo.ts:80-130",
		"foo.ts:30+5",
		"src/api.ts::Foo",
		"src/api.ts::Foo#body",
		"src/api.ts::§function",
		"src/api.ts::Foo//§call",
		"artifact://abc/main/bash/1.txt::§line",
		"src/**/*.ts",
		"tests/**/*.{ts,rs}",
		"src/foo.ts::Foo[0]",
		r#"src/foo.ts::§line[text~="TODO"]"#,
		"src/foo.ts::Foo[§class]",
		"src/foo.ts::Foo[¶return]",
		"src/foo.ts::§line[10..20]",
		"src/foo.ts::Foo[size>1M]",
		"src/foo.ts::Foo[ext=ts]",
		"src/foo.ts::Foo[empty]",
	];

	let lexer = DotLexer;

	c.bench_function("parse_codepath_x1000", |b| {
		b.iter(|| {
			for _ in 0..50 {
				for s in &inputs {
					let result = pi_code_path::parser::parse_code_path(s, &lexer);
					let _ = black_box(result);
				}
			}
		})
	});
}

// ── Benchmark 3: executeCodePath get on 500-line file ───────────
//
// Creates a 500-line temp file, resolves a `§line[10..20]` query via
// CodeResolverImpl.

fn bench_get_500line_file(c: &mut Criterion) {
	let dir = tempdir().expect("tempdir");
	let file_path = dir.path().join("test.rs");

	// Write 500 lines
	{
		let mut f = std::fs::File::create(&file_path).expect("create temp file");
		for i in 1..=500 {
			writeln!(f, "fn func_{i}() {{}} // line {i}").expect("write line");
		}
	}

	let registry = LanguageRegistry::with_builtins().expect("language registry");
	let resolver = CodeResolverImpl::new(Arc::new(registry));

	// Query: §line[10..20] — structural axis by line number
	let query = Query::single(Step {
		axis: Some(Axis::Structural),
		head: Head::NodeKind("line".to_string()),
		predicates: vec![Predicate::Range {
			start: Some(10),
			end: Some(20),
		}],
	});

	let cancel = CancellationToken::new();

	c.bench_function("get_500line_file", |b| {
		b.iter(|| {
			let result = resolver.resolve(&file_path, &query, None, &cancel);
			let _ = black_box(result);
		})
	});
}

// ── Benchmark 4: resolve 50 symbols ─────────────────────────────
//
// Creates a file with 50 function/struct definitions, then resolves
// each by name via CodeResolverImpl.

fn bench_resolve_50_symbols(c: &mut Criterion) {
	let dir = tempdir().expect("tempdir");
	let file_path = dir.path().join("test.ts");

	// Write 50 symbols (alternating functions and structs)
	{
		let mut f = std::fs::File::create(&file_path).expect("create temp file");
		writeln!(f, "// Generated symbols for benchmark").expect("write");
		// Emit syntactically valid TypeScript so the TS grammar produces a clean
		// parse tree (not a recovery-mode parse from Rust syntax in a .ts file).
		for i in 0..25 {
			writeln!(f, "function handler_{i}(x: number): number {{ return x + {i}; }}")
				.expect("write");
			writeln!(f, "class Config_{i} {{ field: string = ''; }}").expect("write");
		}
	}

	let registry = LanguageRegistry::with_builtins().expect("language registry");
	let resolver = CodeResolverImpl::new(Arc::new(registry));
	let cancel = CancellationToken::new();

	// Build 50 symbol queries
	let symbol_names: Vec<String> = (0..25)
		.flat_map(|i| {
			vec![
				format!("handler_{i}"),
				format!("Config_{i}"),
			]
		})
		.collect();

	c.bench_function("resolve_50_symbols", |b| {
		b.iter(|| {
			for name in &symbol_names {
				let query = Query::single(Step {
					axis: None,
					head: Head::Name(NamePayload::Raw(name.clone())),
					predicates: vec![],
				});
				let result = resolver.resolve(&file_path, &query, None, &cancel);
				let _ = black_box(result);
			}
		})
	});
}

// ── Benchmark 5: Edge traversal (def→) — gated ──────────────────
//
// NOT IMPLEMENTED — requires pi-code-graph index (full workspace scan).
// Add when a graph fixture is available to benchmark against.

// ── Criterion harness ───────────────────────────────────────────

criterion_group!(
	name = benches;
	config = Criterion::default()
		.warm_up_time(std::time::Duration::from_millis(500))
		.measurement_time(std::time::Duration::from_secs(5))
		.sample_size(100);
	targets = bench_grep_todo, bench_parse_codepath, bench_get_500line_file, bench_resolve_50_symbols
);
criterion_main!(benches);
