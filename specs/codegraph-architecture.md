# Code Graph Architecture Investigation

## Executive Summary

The Spell code tool has two architectures:
1. **File-local operations**: Emacs 29+ treesit + combobulate (read, outline, navigate, edit, buffers, diff)
2. **Cross-file graph operations**: Native Rust codegraph engine (index, search, context, impact, deps, flow, dead_code, clusters)

The native codegraph is a sophisticated symbol-graph indexer written in Rust, exposed via NAPI bindings. It uses petgraph, tree-sitter, and BM25 full-text search.

---

## Architecture Overview

```
packages/coding-agent/src/tools/code.ts
    ↓
    [GRAPH_COMMANDS set]
    ↓
packages/natives/src/code-graph/index.ts → native.ts
    ↓
crates/pi-natives/src/code_graph.rs [NAPI binding]
    ↓
crates/pi-code-graph/ [Core Rust implementation]
    ├── src/lib.rs [Module exports]
    ├── src/model.rs [Graph data structures]
    ├── src/indexer.rs [Graph builder]
    ├── src/search.rs [BM25 full-text search]
    ├── src/query.rs [Graph traversal algorithms]
    ├── src/cache.rs [Persistence + fingerprinting]
    ├── src/store.rs [Thread-safe graph store]
    ├── src/language.rs [Extractor registry]
    ├── src/language/typescript.rs [TypeScript extractor]
    └── src/language/elixir.rs [Elixir extractor]
```

---

## Graph Commands (GRAPH_COMMANDS)

Dispatched in `code.ts` lines 24-34:
- **index**: Build/rebuild the graph
- **status**: Report graph state without building
- **search**: BM25 full-text search across symbols/files
- **context**: All relationships of a symbol (callers, callees, imports, references)
- **impact**: Breadth-first traversal of inbound semantic edges
- **deps**: File-level import dependencies
- **flow**: Breadth-first call chain
- **dead_code**: Symbols with no inbound semantic references
- **clusters**: Strongly connected components (SCCs)

---

## Data Structures

### Graph Model (`model.rs`)

**Nodes:**
```rust
pub enum GraphNode {
    File(FileNode),
    Symbol(SymbolNode),
}

pub struct FileNode {
    pub path: PathBuf,
    pub language: String,
}

pub struct SymbolNode {
    pub name: String,
    pub qualified_name: String,
    pub file: PathBuf,
    pub kind: SymbolKind,
    pub exported: bool,
    pub line: u32,
    pub column: u32,
    pub detail: Option<String>,
}

pub enum SymbolKind {
    Function, Class, Method, Variable, Interface, TypeAlias,
    Enum, Module, Macro, Template,
}
```

**Edges:**
```rust
pub enum EdgeKind {
    Defines,         // File → Symbol
    Imports,         // File → File (module imports)
    Calls,           // Symbol → Symbol (function calls)
    References,      // Symbol → Symbol (identifier references)
    Inherits,        // Class → Class (inheritance)
    Renders,         // Symbol → Symbol (component/template renders)
    TypeImports,     // File → File (type-only imports)
    TypeParameterOf, // Symbol → Symbol (type parameters)
}
```

**Graph Container:**
```rust
pub struct PersistedCodeGraph {
    pub root: PathBuf,
    pub graph: StableGraph<GraphNode, EdgeKind, Directed>,
    pub stats: GraphStats,
    pub generated_at_ms: u64,
    pub git_head: Option<String>,
}

pub struct CodeGraph {
    persisted: PersistedCodeGraph,
    search_index: SearchIndex,  // Built on-demand from graph
}
```

---

## Indexing Process (`indexer.rs`)

### Build Flow
1. **Walk project**: `ignore::WalkBuilder` (respects .gitignore, excludes .spell/)
2. **Language matching**: `LanguageRegistry::match_path()` → supported language?
3. **Parse & extract**: Call `LanguageExtractor::extract()` for each file
4. **Symbol extraction**: Collect `ExtractedSymbol` from AST
5. **Reference extraction**: Inline references within each symbol
6. **Import extraction**: Collect `ExtractedImport` statements
7. **Build graph incrementally**:
   - Add file nodes
   - Add symbol nodes with `EdgeKind::Defines` to files
   - Resolve imports → create `EdgeKind::Imports` edges
   - Resolve references → create semantic edges (Calls, References, etc.)

### Key Data Flow
```
Source file → Parser → ExtractedFile {
    path: PathBuf,
    language: SupportedLanguage,
    symbols: Vec<ExtractedSymbol>,
    imports: Vec<ExtractedImport>,
}

ExtractedSymbol {
    name, qualified_name, kind, exported,
    line, column, detail,
    references: Vec<ExtractedReference>,  // Intra-symbol refs
}

ExtractedImport {
    specifier: String,  // Module name
    bindings: Vec<ExtractedImportBinding>,
    is_type_only: bool,
}
```

---

## Symbol & Import Extraction

### TypeScript Extractor (`language/typescript.rs`)

**Parser**: tree-sitter (TypeScript/TSX/JSX/JS variants)

**Symbol extraction**:
- `import_statement` → creates imports
- `export_statement` → marks symbols as exported
- Declaration kinds (functions, classes, interfaces, etc.) → symbols
- Tracks `exported_names: BTreeSet` separately, merged post-parse

**Import resolution** (`TypeScriptImportResolver`):
- Uses `oxc_resolver` for Node.js resolution
- Reads `tsconfig.json` if present
- Attempts extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`
- Implements extension aliasing (`.js` → `.ts`, etc.)
- Returns relative path normalized against project root

**Extensions matched**: ts, tsx, mts, cts, js, jsx, mjs, cjs

### Elixir Extractor (`language/elixir.rs`)

**Parser**: tree-sitter with regex post-processing

**Symbol extraction**:
- `defmodule Module.Name` → Module symbol (exported)
- `def/defp/macro/guard` → Functions
- Tracks module name for qualified_name construction

**Import resolution** (`ElixirImportResolver`):
- Module name → file path using Elixir conventions
- Checks `lib/module_path.{ex,exs}` or `lib/module_path/index.ex`
- Fallback: project root with same structure

**Extensions matched**: ex, exs, heex

---

## Search Algorithm (`search.rs`)

### BM25 Full-Text Search

```rust
pub struct SearchIndex {
    docs: Vec<SearchDocument>,
    avg_doc_len: f32,
    term_doc_freq: BTreeMap<String, usize>,
}

struct SearchDocument {
    node_index: usize,
    label: String,           // qualified_name or file path
    path: PathBuf,
    tokens: Vec<String>,     // Tokenized label
    frequencies: BTreeMap<String, usize>,
}
```

**Tokenization** (`tokenize()`):
- Split on non-alphanumeric (excluding `_`, `-`)
- Lowercase
- Filter empty tokens

**BM25 Formula**:
```
k1 = 1.5, b = 0.75
For each query token:
  tf = term frequency in document
  df = document frequency in corpus
  idf = ln((N - df + 0.5) / (df + 0.5))
  norm = k1 * (1 - b + b * doc_len / avg_doc_len)
  score += idf * ((tf * (k1 + 1)) / norm)
```

**Ranking**:
1. Sort by score descending
2. Tiebreak: lexicographic by label

**Why exact symbol lookup sometimes fails**:
- Symbol must be indexed with exact `qualified_name` or `name` match
- If symbol name includes path separators (e.g., `tools/code.ts::CodeTool`), BM25 tokenizes on `::` → tokens: `["tools/code.ts", "CodeTool"]`
- Query `CodeTool` searches for exact token match or partial match
- **Problem**: Qualified names with complex module paths may not tokenize as expected; search is fuzzy, not exact lookup
- **Fallback**: `resolve_symbol()` attempts exact match first, then falls back to BM25 search with partial name matching

---

## Graph Traversal Algorithms (`query.rs`)

### Context (`graph_context()`)
```
target: query → symbol
├─ callers: incoming Calls edges
├─ callees: outgoing Calls edges
├─ references: outgoing References edges
├─ referenced_by: incoming References edges
├─ imports: file-level imports (via symbol's file)
├─ imported_by: file-level imports in reverse
└─ inherits: outgoing Inherits edges
```

### Impact (`graph_impact()`)
- BFS from symbol/file
- Direction: **Incoming** (who calls/uses this?)
- Edge types: Calls, References, Inherits, Imports, TypeImports, TypeParameterOf
- Max depth: configurable
- Output: levels by depth

### Flow (`graph_flow()`)
- BFS from symbol
- Direction: **Outgoing** (what does this call?)
- Edge types: Calls only
- Max depth: configurable
- Output: levels by depth

### Deps (`graph_deps()`)
- File-level only
- Outgoing: Imports edges
- Incoming: Imports edges (reverse)

---

## Dead Code Detection (`graph_dead_code()`)

**Criteria for "dead" symbols**:
- NOT exported (`symbol.exported == false`)
- NOT a Module or Template kind
- NOT a constructor method
- NO inbound semantic edges of type: Calls, References, Inherits, Renders

**Why noisy**:
1. **False positives**: Symbols with no direct inbound edges may be entry points or indirectly referenced (not yet extracted)
2. **Language-specific gaps**: Not all reference types may be extracted (e.g., dynamic/reflection)
3. **Type-only edges**: TypeImports/TypeParameterOf ignored in inbound check
4. **Export detection**: Relies on explicit `export` keyword; re-exports or runtime registration missed
5. **Template/Component edges**: Renders edge may not be created if extraction doesn't recognize component invocations

---

## Clusters / Strongly Connected Components (`graph_clusters()`)

**Algorithm**: Kosaraju's SCC algorithm (via petgraph)

**Output**: 
- Each SCC grouped
- Filters to only groups with file nodes
- Counts symbols per cluster
- Lists files in cluster

**Why noisy**:
1. **Over-grouping**: Files in the same cycle (A→B→C→A) all belong to one SCC, even if only one edge actually creates the cycle
2. **Type-only edges included**: TypeImports counted as hard dependencies, inflating coupling
3. **Unexported symbols**: SCC includes internal symbols, not just public API
4. **Transitive closure**: Indirect paths create larger clusters than intuition suggests
5. **No semantic weighting**: All edge types (calls, imports, references) treated equally

---

## Persistence (`cache.rs`)

### Cache Storage
```
.spell/graph/
├── workspace.bin  [bincode-serialized PersistedCodeGraph]
```

**Serialization**: bincode (binary, not human-readable)

### Fingerprinting Strategy
```rust
pub struct GraphFingerprint {
    pub root: PathBuf,
    pub git_head: Option<String>,
    pub files: BTreeMap<PathBuf, FileFingerprint>,
}

pub struct FileFingerprint {
    pub size: u64,
    pub modified_at_ms: u64,
}
```

**Cache freshness check**:
1. Load cached fingerprint
2. Compute current fingerprint (walk project, get file metadata)
3. Compare:
   - git HEAD changed? → Stale
   - Any file size/mtime changed? → Stale
   - All unchanged? → Fresh

**Cache invalidation**:
- Explicit rebuild (`index` command forces rebuild)
- Git HEAD change
- Any source file modification

---

## NAPI Binding (`code_graph.rs`)

**Entry point**: `execute_code_graph()` (line 72)

**Command dispatch** (lines 101–160):
```rust
match options.command.as_str() {
    "index" → rebuild + render_status()
    "status" → render cached status (no rebuild)
    "context" → graph_context(symbol) + format_context()
    "impact" → graph_impact(symbol, depth) + format_impact()
    "deps" → graph_deps(file) + format_deps()
    "flow" → graph_flow(symbol, depth) + format_flow()
    "dead_code" → graph_dead_code() + format_dead_code()
    "clusters" → graph_clusters() + format_clusters()
    "search" → graph_search(query, limit) + format_search()
}
```

**Result format**:
```rust
pub struct CodeGraphResult {
    pub output: String,           // Human-readable text
    pub cache_status: String,     // "missing" | "fresh" | "stale (reason)"
    pub rebuilt: bool,
    pub file_count: u32,
    pub symbol_count: u32,
    pub edge_count: u32,
}
```

**Defaults**:
- `depth`: 3 (for impact/flow)
- `limit`: 10 (for result truncation)

---

## TypeScript Binding (`packages/natives/src/code-graph/types.ts`)

```typescript
export interface CodeGraphOptions extends Cancellable {
    command: string;
    root?: string;
    file?: string;
    symbol?: string;
    query?: string;
    depth?: number;
    limit?: number;
}

export interface CodeGraphResult {
    output: string;
    cacheStatus: string;
    rebuilt: boolean;
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
}
```

**Declaration merging** in `native.ts` extends `NativeBindings`:
```typescript
declare module "../bindings" {
    interface NativeBindings {
        executeCodeGraph(options: CodeGraphOptions): Promise<CodeGraphResult>;
    }
}
```

---

## Tool Integration (`code.ts`)

**Dispatcher** (lines 126–127):
```typescript
if (GRAPH_COMMANDS.has(command)) {
    return await this.#executeGraphCommand(params, signal);
}
```

**Graph execution wrapper** (lines 150–170):
```typescript
async #executeGraphCommand(params: CodeParams, signal?: AbortSignal): Promise<AgentToolResult> {
    const result = await executeCodeGraph({
        command: params.command,
        root: this.#session.cwd ?? getProjectDir(),
        file: params.file,
        symbol: params.symbol,
        query: params.query,
        depth: params.depth,
        limit: params.limit,
        signal,
    });
    return {
        content: [{ type: "text", text: result.output }],
        details: {
            command: params.command,
            cacheStatus: result.cacheStatus,
            rebuilt: result.rebuilt,
            graph: true,
        },
    };
}
```

---

## Dependencies & External Libraries

### Rust Crate: `pi-code-graph`

**Key dependencies** (Cargo.toml):
- `petgraph 0.8` — Graph data structure (StableGraph<NodeType, EdgeType, Directed>)
- `tree-sitter 0.25` — AST parsing
- `tree-sitter-typescript 0.23` — TypeScript/TSX/JSX grammar
- `tree-sitter-javascript 0.25` — JavaScript grammar
- `tree-sitter-elixir 0.3` — Elixir grammar
- `oxc_resolver 1.12` — Node.js module resolution
- `serde 1 + serde_json 1` — Serialization
- `bincode 1.3` — Binary serialization for cache
- `ignore 0.4` — Respects .gitignore during walks
- `regex 1` — Regex-based extraction (Elixir)
- `arc-swap 1.7` — Atomic arc swap for GraphStore

**Rust crate: `pi-natives`**
- `napi-derive` — NAPI procedural macro
- All above re-exported via `pi_code_graph` import

---

## Configuration & Tuning Knobs

### BM25 Parameters (`search.rs` lines 88–89)
```rust
let k1 = 1.5_f32;  // Term frequency saturation
let b = 0.75_f32;  // Length normalization factor
```
**Tuning impact**:
- `k1`: Higher → more weight on term frequency; lower → diminishing returns
- `b`: Higher (→1.0) → penalize short documents; lower (→0.0) → ignore doc length

### Traversal Depths
- `DEFAULT_DEPTH = 3` (impact, flow commands)
- User-overridable via `depth` parameter

### Search Limits
- `DEFAULT_LIMIT = 10`
- User-overridable via `limit` parameter

### Cache Location
- Fixed at `.spell/graph/workspace.bin`
- Cache validity: git HEAD + source file metadata

### Language Registry
- Extensible via `LanguageRegistry::register()`
- Currently: TypeScript (default) + Elixir
- Add language: create `LanguageExtractor + ImportResolver` pair

---

## Known Limitations

### Search (`search.rs`)

1. **Exact symbol lookup fails when**:
   - Symbol name not in tokenized form (e.g., qualified names with `::` separators)
   - BM25 tokenizes query—may not match multipart qualifiers
   - Partial name matching required; fuzzy, not exact

2. **Solution**: `resolve_symbol()` (query.rs) tries:
   - Exact match first (`qualified_name == query || name == query`)
   - Falls back to BM25 search with partial name filtering

### Dead Code Detection

1. **False positives**:
   - No edges = "dead", but may be:
     - Entry points (called from outside graph)
     - Indirectly referenced (reflection, dynamic imports)
     - Used in comments/docs
   - Only exported symbols are safe from false positives

2. **False negatives**:
   - Constructor methods never marked dead (hardcoded exception)
   - Templates/Module kinds exempt
   - No analysis of re-exports

### Clusters

1. **Over-grouping**:
   - All files in an SCC treated as one monolith
   - Type-only imports create hard dependencies
   - No distinction between intentional coupling and accidental cycles

2. **No weighting**:
   - All edge types equal (calls = imports = renders)

---

## Performance Characteristics

### Indexing
- **Complexity**: O(files * lines * AST traversal)
- **Bottlenecks**: Tree-sitter parsing, module resolution (oxc_resolver walks filesystem)
- **Cache hit**: O(fingerprint check) + O(deserialization) ≈ fast
- **Cache miss**: Full build

### Searching
- **Complexity**: O(documents * query_tokens * term lookups) = O(n * m)
- **Fast path**: BM25 with precomputed IDF terms
- **Memory**: All docs in RAM (SearchIndex)

### Graph Traversal
- **BFS**: O(V + E) where V = nodes, E = edges
- **SCC**: Kosaraju O(V + E)

---

## Integration Points

### From `code.ts`
```typescript
const result = await executeCodeGraph({
    command: string,
    root?: string,
    file?: string,
    symbol?: string,
    query?: string,
    depth?: number,
    limit?: number,
    signal?: AbortSignal,
});
```

### Result Content
- `result.output`: Human-readable text response
- `result.cacheStatus`: "missing" | "fresh" | "stale (reason)"
- `result.rebuilt`: Boolean
- Graph stats: `fileCount`, `symbolCount`, `edgeCount`

---

## Recommendations for Improvement

### Search Accuracy
1. **Issue**: Exact symbol queries fail due to fuzzy BM25 matching
2. **Fix**: Implement dual-mode search:
   - Exact match on `qualified_name` + `name` fields
   - Fallback to BM25 for fuzzy matching
   - Cache exact symbol index (HashMap<String, NodeIndex>)

### Dead Code Accuracy
1. **Issue**: No inbound edges ≠ unused; ignores indirect usage
2. **Fix**:
   - Mark symbols with no semantic edges as **potentially unused** (softer categorization)
   - Add option to include exported symbols (may be re-exported)
   - Analyze call stacks to find true entry points

### Cluster Clarity
1. **Issue**: Over-grouping obscures actual tight couplings
2. **Fix**:
   - Weight edges (Calls > References > Imports)
   - Separate intentional vs. accidental cycles
   - Use weakly connected components for broader analysis

### Language Extensibility
1. **Current**: Built-in TypeScript + Elixir
2. **Improvement**:
   - Expose `LanguageExtractor` trait in NAPI (allow plugins)
   - Provide WASM extractor sandbox
   - Or: Accept community contributions (add Python, Go, Rust)

---

## Summary Table

| Aspect | Technology | Notes |
|--------|-----------|-------|
| **Graph storage** | petgraph StableGraph | Directed, node-weighted, edge-weighted |
| **Persistence** | bincode serialization | Binary, not human-readable |
| **Cache validation** | File fingerprint + git HEAD | Invalidates on any source change |
| **Search** | BM25 | Fuzzy, not exact; tunable k1, b |
| **Traversal** | BFS + SCC (Kosaraju) | Configurable depth |
| **Symbol extraction** | tree-sitter AST | TypeScript + Elixir; extensible |
| **Module resolution** | oxc_resolver (TypeScript) + Elixir conventions | respects tsconfig.json, .gitignore |
| **NAPI binding** | Rust → TypeScript | Async tasks, cancellation support |
| **Tool integration** | Code tool dispatcher | One of ~10 graph commands |

