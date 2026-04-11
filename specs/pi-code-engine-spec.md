# pi-code-engine: Unified Code Intelligence Engine

**Status**: Design spec — not yet implemented
**Date**: 2026-04-11
**Scope**: Replace Emacs-backed file-local operations in the `code` tool with a Rust crate. Unify language understanding, structural editing, buffer management, and graph extraction under one engine.

---

## 1. Goals

1. Eliminate the Emacs daemon dependency for the `code` tool entirely. All 16 subcommands route through Rust NAPI bindings.
2. Unify language definitions: one declarative profile drives outline, read, navigate, structural edits, AND graph extraction.
3. Introduce persistent code buffers with rope, incremental tree-sitter parsing, CRDT-based multi-agent editing (loro), and per-agent tree-based undo.
4. Ship structural editing (splice, drag, clone, transpose) in Rust — no combobulate dependency.
5. Fix graph quality: search tokenization, dead_code precision, clusters algorithm.
6. Add diff-aware graph queries and inline graph annotations in read output.
7. Add incremental graph indexing.

## 2. Crate Organization

### `pi-code-engine` (new crate)
File-scoped code intelligence. Zero UI dependencies.

```
crates/pi-code-engine/
  Cargo.toml
  build.rs                  # Generate production rules from node-types.json
  src/
    lib.rs                  # Public API re-exports
    buffer.rs               # CodeBuffer: rope + tree-sitter + CRDT + undo
    diff.rs                 # Structural diff (difftastic integration)
    outline.rs              # Outline extraction (resolution 0-3)
    navigate.rs             # Navigate actions (node-at, defun-at, siblings, children, parent, references)
    edit/
      mod.rs                # EditEngine: apply operations on CodeBuffer
      splice.rs             # Splice up/self/down
      drag.rs               # Drag up/down (swap siblings)
      clone.rs              # Clone with separator and indent
      transpose.rs          # Swap adjacent nodes
      replace.rs            # Simple replace/insert/kill
      indent.rs             # Indentation adjustment utilities
    procedure/
      mod.rs                # Procedure type + builder API
      activation.rs         # Phase 1: node type matching + constraints
      selector.rs           # Phase 2: children/sibling/query filtering
      rules.rs              # Rule expansion engine (rule, irule, rx, exclude, etc.)
    language/
      mod.rs                # LanguageProfile trait + LanguageRegistry
      profile.rs            # YAML/JSON profile loader
      generated/            # Build-time generated production rules per grammar
        mod.rs
        typescript.rs
        rust.rs
        python.rs
        elixir.rs
    error.rs                # Crate error types
```

**Dependencies**: `ropey`, `tree-sitter` (+ grammar crates), `loro`, `difftastic`, `regex`, `serde`, `serde_yaml`

### `pi-code-graph` (existing crate, refactored)
Cross-file graph intelligence. Depends on `pi-code-engine` for language profiles and symbol extraction.

**Changes**:
- Remove `language/typescript.rs` and `language/elixir.rs` extractors
- Replace with profile-driven extraction from `pi-code-engine::language::LanguageRegistry`
- Fix search tokenizer (camelCase/snake_case splitting, exact-match boost)
- Fix dead_code (entry point heuristics, confidence, test file filtering)
- Fix clusters (weakly connected components, min size filter)
- Add diff-aware graph queries
- Add incremental indexing

### `pi-natives` (existing, updated)
NAPI bindings. Imports both `pi-code-engine` and `pi-code-graph`. Exposes:
- `executeCodeBuffer(command, ...)` — buffer management, outline, read, navigate, edit
- `executeCodeGraph(command, ...)` — graph commands (existing, updated)

---

## 3. Buffer Design (`buffer.rs`)

### Core Type: `CodeBuffer`

```rust
pub struct CodeBuffer {
    // Text storage: O(log N) edits, cheap Arc snapshots
    rope: Rope,

    // Incremental parser: sub-ms re-parse after edits via InputEdit
    tree: Tree,
    parser: Parser,

    // Language identity
    language: LanguageId,

    // CRDT: multi-agent concurrent editing
    crdt: LoroDoc,
    agent_id: AgentId,

    // Tree-based undo per agent
    history: History,

    // Metadata
    version: u64,
    path: Option<PathBuf>,
    dirty: bool,
}
```

### CRDT Integration (loro)

- Each agent gets a unique `AgentId` (session-scoped)
- Edits go through loro's text CRDT → materialized into rope → tree-sitter re-parse
- Per-agent undo via loro's built-in `UndoManager`
- Branching: `LoroDoc::fork()` creates an independent branch for speculative edits
- Merge: `LoroDoc::merge(&other)` integrates branches with automatic conflict resolution (Fugue algorithm prevents interleaving anomalies)
- Diff: loro provides operation-based diff between versions

### Edit Flow

```
Agent calls buffer.edit(TextEdit)
  → loro CRDT records operation with agent_id + Lamport timestamp
  → rope mutated: rope.insert(pos, text) / rope.remove(range)
  → InputEdit computed from rope mutation (byte offsets, positions)
  → tree.edit(&input_edit) + parser.parse(rope_input, Some(&tree))
  → history records (transaction, inverse) for undo
  → version incremented, dirty = true
  → EditResult returned with old_tree, new_tree, changed_ranges
```

### Snapshot and Diff

- `buffer.snapshot()`: cheap Arc clone of rope + tree + loro state
- `buffer.diff_from(snapshot)`: difftastic structural diff between versions
- `buffer.diff_from_disk()`: compare current buffer against file on disk

### History (Helix pattern)

```rust
struct History {
    revisions: Vec<Revision>,
    current: usize,
}

struct Revision {
    parent: usize,
    last_child: Option<usize>,
    transaction: Transaction,  // forward edits
    inverse: Transaction,      // inverse edits for undo
}
```

- `undo()`: apply inverse of current revision, move to parent
- `redo()`: apply transaction of last_child, move forward
- `jump_to(target)`: compute LCA, apply inversions back, forward transactions forward

### Buffer Registry

```rust
pub struct BufferRegistry {
    buffers: HashMap<PathBuf, CodeBuffer>,
    registry: Arc<LanguageRegistry>,
}

impl BufferRegistry {
    pub fn open(&mut self, path: &Path, agent: AgentId) -> Result<&mut CodeBuffer>;
    pub fn close(&mut self, path: &Path) -> Result<()>;
    pub fn list(&self) -> Vec<BufferInfo>;
    pub fn get(&self, path: &Path) -> Option<&CodeBuffer>;
    pub fn get_mut(&mut self, path: &Path) -> Option<&mut CodeBuffer>;
}
```

---

## 4. Language Profile Format

### YAML Definition

```yaml
# .spell/languages/rust.yaml or built-in profiles
language: rust
extensions: [rs]

declarations:
  - node_types: [function_item]
    name_field: name
    kind: fn
    body_field: body
  - node_types: [struct_item]
    name_field: name
    kind: struct
    body_field: body
  - node_types: [enum_item]
    name_field: name
    kind: enum
    body_field: body
  - node_types: [impl_item]
    name_field: type     # impl has type, not name
    kind: impl
    body_field: body
  - node_types: [trait_item]
    name_field: name
    kind: trait
    body_field: body
  - node_types: [mod_item]
    name_field: name
    kind: mod
    body_field: body
  - node_types: [type_item]
    name_field: name
    kind: type
  - node_types: [const_item]
    name_field: name
    kind: const
  - node_types: [static_item]
    name_field: name
    kind: static

class_like:
  - node_type: impl_item
    body_field: body
    member_types: [function_item, const_item, type_item]

imports:
  - node_type: use_declaration
    specifier_field: argument    # use path::to::module;

exports:
  - node_type: function_item
    visibility: pub              # check for pub keyword
  - node_type: struct_item
    visibility: pub

references:
  - node_type: identifier
    exclude_parent_types: [line_comment, block_comment, string_literal, raw_string_literal]

separators: [",", ";"]
```

### Build-Time Generation

`build.rs` reads each grammar's `node-types.json` (shipped with tree-sitter grammar crates) and generates:

```rust
// crates/pi-code-engine/src/language/generated/typescript.rs
pub const PRODUCTION_RULES: &[(&str, ProductionRule)] = &[
    ("if_statement", ProductionRule {
        unnamed: &[],
        fields: &[
            ("alternative", &["else_clause"]),
            ("condition", &["parenthesized_expression"]),
            ("consequence", &["statement"]),
        ],
    }),
    // ... all node types
];

pub const INVERSE_RULES: &[(&str, &[&str])] = &[
    ("if_statement", &["module", "statement_block", "switch_case"]),
    // ...
];

pub const ALL_TYPES: &[&str] = &["if_statement", "function_declaration", ...];
pub const SUPERTYPES: &[&str] = &["expression", "statement", "declaration", ...];
```

### Registry

```rust
pub struct LanguageRegistry {
    profiles: HashMap<LanguageId, LanguageProfile>,
}

impl LanguageRegistry {
    pub fn with_builtins() -> Self; // TS, Rust, Python, Elixir
    pub fn register_profile(&mut self, profile: LanguageProfile) -> Result<()>;
    pub fn load_from_dir(&mut self, dir: &Path) -> Result<()>; // .spell/languages/
    pub fn match_path(&self, path: &Path) -> Option<&LanguageProfile>;
    pub fn get(&self, id: &LanguageId) -> Option<&LanguageProfile>;
}
```

---

## 5. Procedure DSL

### Builder API

```rust
use pi_code_engine::procedure::*;

let proc = Procedure::builder()
    .activate(|a| a
        .nodes(rule("expression"))
        .has_parent(&["call_expression"])
        .has_field("arguments")
        .position(Position::At))
    .activate(|a| a
        .nodes(types(&["identifier", "string"]))
        .has_ancestor(&["template_literal"]))
    .select(|s| s
        .choose(Target::Parent)
        .match_children(|m| m
            .discard(&["comment"])
            .default_mark(Mark::Match)))
    .build();
```

### Type Definitions

```rust
pub enum RuleExpr {
    Types(Vec<&'static str>),               // direct node type list
    Rule { name: &'static str, fields: Vec<&'static str> },  // production rule expansion
    InverseRule(&'static str),              // inverse lookup
    Regex(String),                          // regex against all types
    RuleRegex(String),                      // regex match then expand
    Exclude { include: Box<RuleExpr>, exclude: Box<RuleExpr> },
    All,                                    // match everything
}

pub enum Position { Any, At, In }

pub struct ActivationRule {
    pub nodes: RuleExpr,
    pub position: Position,
    pub has_parent: Option<RuleExpr>,
    pub has_ancestor: Option<RuleExpr>,
    pub has_fields: Option<Vec<&'static str>>,
}

pub struct Procedure {
    pub activation_nodes: Vec<ActivationRule>,
    pub selector: Option<Selector>,
}
```

### Execution

```rust
pub fn apply_procedure(
    procedure: &Procedure,
    node: &Node,
    point: usize,
    rules: &ProductionRules,
) -> Option<ProcedureResult> {
    // Phase 1: try each activation rule until one matches
    // Phase 2: if selector present, filter results
    // Phase 3: extract @match nodes
}
```

---

## 6. Structural Edit Operations

All operations take a `CodeBuffer` and return `Vec<TextEdit>`:

### Splice

```rust
pub enum SpliceMode { Up, Self_, Down }

pub fn splice(
    buffer: &CodeBuffer,
    line: usize,
    mode: SpliceMode,
    profile: &LanguageProfile,
) -> Result<Vec<TextEdit>>;
```

Algorithm:
1. Find node at line via tree
2. Apply sibling procedure to find partitioned nodes
3. Filter by mode (Up = self+after+around, Self_ = self, Down = self+before+around)
4. Get range extent of kept nodes
5. Find legal splice parent (walk up looking for valid container)
6. Build edit: delete parent range, insert kept text with indent adjustment
7. Process edits high-to-low to avoid position shifts

### Drag

```rust
pub enum DragDirection { Up, Down }

pub fn drag(
    buffer: &CodeBuffer,
    line: usize,
    direction: DragDirection,
    profile: &LanguageProfile,
) -> Result<Vec<TextEdit>>;
```

Algorithm:
1. Find nearest navigable node at line
2. Get sibling in direction (prev for up, next for down)
3. Swap their text regions (two edits, processed high-to-low)

### Clone

```rust
pub fn clone_node(
    buffer: &CodeBuffer,
    line: usize,
    profile: &LanguageProfile,
) -> Result<Vec<TextEdit>>;
```

Algorithm:
1. Find navigable node at line
2. Extract node text
3. Detect separator (check anonymous sibling after node, match against profile.separators)
4. Calculate indentation: original indent vs target indent
5. Build insert edit at node end position with adjusted indent + separator

### Transpose

```rust
pub fn transpose(
    buffer: &CodeBuffer,
    line: usize,
    column: usize,
    profile: &LanguageProfile,
) -> Result<Vec<TextEdit>>;
```

Algorithm:
1. Find sexp-like node before point (backward scan via procedure)
2. Find sexp-like node after point (forward scan)
3. Swap their text regions

### Indentation Utilities

```rust
/// Adjust first line to target column, shift remaining lines by delta.
pub fn adjust_indent(text: &str, target_column: usize, original_column: usize) -> String;

/// Get the indentation column of a node's first line.
pub fn node_indent(source: &str, node: &Node) -> usize;

/// Detect the indentation unit of a file (tabs vs N spaces).
pub fn detect_indent(source: &str) -> IndentStyle;
```

---

## 7. Outline and Navigate

### Outline

```rust
pub fn outline(buffer: &CodeBuffer, profile: &LanguageProfile) -> Vec<OutlineEntry>;

pub struct OutlineEntry {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub end_line: u32,
    pub column: u32,
    pub exported: bool,
    pub signature: String,
    pub children: Vec<OutlineEntry>,  // class members
}
```

Driven by `profile.declarations`: walk top-level tree-sitter nodes, match against declaration node_types, extract name from name_field, stub body for signature.

### Resolution-Aware Read

```rust
pub fn read(
    buffer: &CodeBuffer,
    profile: &LanguageProfile,
    resolution: u8,      // 0-3
    offset: Option<u32>,
    limit: Option<u32>,
) -> String;
```

- Resolution 0: names only
- Resolution 1: signatures (bodies stubbed to `{ ... }`)
- Resolution 2: structure (class members visible, method bodies stubbed)
- Resolution 3: full source with optional line range

### Navigate

```rust
pub enum NavigateAction {
    NodeAt,
    DefunAt,
    Parent,
    Siblings,
    Children,
    References { symbol: Option<String> },
}

pub fn navigate(
    buffer: &CodeBuffer,
    profile: &LanguageProfile,
    action: NavigateAction,
    line: u32,
    column: Option<u32>,
    graph: Option<&CodeGraph>,  // for references enrichment
) -> Result<NavigateResult>;
```

References integration:
1. Use `symbol` parameter if provided (don't derive from position)
2. Tree-sitter text search within file, filtering out comment/string nodes
3. If graph available, cross-reference matches against graph edges for confidence
4. Warn in output if graph not available

---

## 8. Graph Improvements

### Search Tokenization

Replace the tokenizer in `search.rs`:

```rust
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    // Split on non-alphanumeric (existing)
    for part in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-') {
        if part.is_empty() { continue; }
        let lower = part.to_ascii_lowercase();
        tokens.push(lower.clone());

        // CamelCase splitting: FluidOrchestrator → [fluid, orchestrator]
        let camel_parts = split_camel_case(part);
        if camel_parts.len() > 1 {
            for cp in &camel_parts {
                tokens.push(cp.to_ascii_lowercase());
            }
        }

        // snake_case splitting: build_system → [build, system]
        let snake_parts: Vec<_> = lower.split('_').filter(|s| !s.is_empty()).collect();
        if snake_parts.len() > 1 {
            for sp in snake_parts {
                tokens.push(sp.to_string());
            }
        }
    }
    tokens.sort();
    tokens.dedup();
    tokens
}
```

Add exact-match boost in `search()`:
```rust
// Before BM25 scoring, check exact substring match
let exact_boost = if doc.label.contains(query) { 10.0 } else { 1.0 };
score *= exact_boost;
```

### Dead Code

```rust
pub fn graph_dead_code(&self, options: &DeadCodeOptions) -> Vec<GraphDeadCodeItem> {
    // Filter: skip exported, modules, templates, constructors (existing)
    // NEW: skip symbols in test files (path contains test/, spec/, __tests__/)
    // NEW: skip main/index entry points
    // NEW: confidence scoring (high: unexported + no refs + not in test. medium: etc.)
    // NEW: sort by confidence desc
    // NEW: limit to options.limit (default 50)
}
```

### Clusters

Replace Kosaraju SCC with weakly connected components:

```rust
pub fn graph_clusters(&self, options: &ClusterOptions) -> Vec<GraphCluster> {
    // Use undirected graph (ignore edge direction)
    // Find connected components via BFS/DFS
    // Filter: minimum cluster size (default 2)
    // Sort: by file count descending
    // Name: use common path prefix of files in cluster
    // Include: cohesion score (internal edges / total edges)
}
```

### Diff-Aware Graph

```rust
pub fn graph_diff(&self, base_graph: &CodeGraph) -> GraphDiff {
    // Compare two graph snapshots
    // Return: added symbols, removed symbols, added edges, removed edges
    // Group by file for readability
}
```

Integration: `code { command: "diff", symbol: "HEAD~3" }` builds graph at base commit, diffs against current.

### Incremental Indexing

```rust
pub fn build_incremental(&self, options: &BuildGraphOptions) -> Result<GraphBuildOutcome> {
    let current = self.cache.load()?;
    let fingerprint = self.fingerprint(&options.root)?;

    // Detect changed files since last build
    let changed = fingerprint.changed_files(&current.fingerprint);
    let removed = fingerprint.removed_files(&current.fingerprint);

    // Re-extract only changed files
    let new_extractions = self.extract_files(&changed)?;

    // Patch graph:
    // 1. Remove all nodes/edges for removed + changed files
    // 2. Add new nodes/edges from re-extracted files
    // 3. Re-resolve imports for changed files

    // petgraph StableGraph supports stable indices across mutations
}
```

---

## 9. Code Tool Migration

### Routing Changes (`packages/coding-agent/src/tools/code.ts`)

Current:
- Graph commands → `pi-natives/executeCodeGraph`
- File commands → Emacs daemon via JSON-RPC

New:
- Graph commands → `pi-natives/executeCodeGraph` (updated)
- Buffer/file commands → `pi-natives/executeCodeBuffer` (new NAPI binding)
- Emacs daemon: **not used by code tool**

### New NAPI Binding

```typescript
// packages/natives/src/code-buffer/types.ts
interface CodeBufferOptions {
    command: string;    // open, close, read, outline, navigate, edit, undo, redo, diff, list
    file?: string;
    resolution?: number;
    action?: string;    // navigate action
    line?: number;
    column?: number;
    symbol?: string;
    operation?: string; // edit operation
    content?: string;
    target?: { line: number; node_type?: string };
    offset?: number;
    limit?: number;
    agent_id?: string;
    save?: boolean;
}

interface CodeBufferResult {
    output: string;     // JSON or formatted text
    error?: boolean;
}
```

### Inline Graph Annotations

When `code read` returns at resolution 2 or 3, the TypeScript layer enriches the output:
- After each declaration, append a comment: `// 12 callers, 5 callees`
- Graph data fetched from `executeCodeGraph({ command: "context", symbol: "..." })`
- Only for exported symbols (avoid noise)

### Emacs Removal from Code Tool

Files modified:
- `packages/coding-agent/src/tools/code.ts`: route all commands through NAPI, remove `#inner` (Emacs CodeToolDefinition)
- `packages/emacs/src/tool.ts`: remove code tool registration (keep org tools)
- `packages/coding-agent/src/prompts/tools/code.md`: update prompt for new capabilities
- `packages/emacs/src/types.ts`: remove CodeEditOperation, OutlineEntry (now in Rust)

Files NOT modified (Emacs stays for org-mode):
- `packages/emacs/src/daemon.ts`
- `packages/emacs/src/session-manager.ts`
- `packages/emacs/src/client.ts` (keep for org operations)

---

## 10. Dependency Choices

| Crate | Version | Purpose | Why this one |
|-------|---------|---------|-------------|
| `ropey` | latest | Rope text buffer | Production-grade, 1600+ stars, O(log N), cheap Arc snapshots, line-aware |
| `loro` | latest | CRDT for multi-agent editing | Fugue algorithm (no interleaving), built-in UndoManager, Rust-native |
| `tree-sitter` | 0.25+ | Incremental parsing | Already used in pi-code-graph, InputEdit API for incremental re-parse |
| `difftastic` | latest | Structural diff | Dijkstra-based tree diff, syntax-aware, published crate |
| `regex` | latest | Rule expansion patterns | Already used in pi-code-graph |
| `serde` + `serde_yaml` | latest | Language profile loading | Standard Rust serialization |
| `petgraph` | latest | Graph data structure | Already used in pi-code-graph |

---

## 11. Testing Strategy

### Unit Tests (Rust, `cargo test`)

Each module has its own test suite:

- **buffer**: open/edit/undo/redo/snapshot/diff lifecycle tests
- **procedure**: activation matching, selector filtering, rule expansion (all RuleExpr variants)
- **edit/splice**: splice up/self/down on concrete code samples per language
- **edit/drag**: drag up/down with indent preservation
- **edit/clone**: clone with separator detection, indent adjustment
- **edit/transpose**: swap adjacent nodes
- **outline**: outline extraction per language vs expected entries
- **navigate**: each action per language, including edge cases (whitespace, comment, blank line)
- **language**: profile loading, registry matching, generated rules validation
- **search**: camelCase/snake_case tokenization, exact-match boost, BM25 ranking
- **dead_code**: entry point filtering, confidence scoring
- **clusters**: weakly connected components, min size filter

### Integration Tests (TypeScript, `bun test`)

- NAPI binding round-trip: open buffer → edit → read → verify
- Full pipeline: open file → outline → navigate → edit → diff → save
- Graph integration: index → search → context → impact with fixed test repo
- Multi-agent: two agents edit same buffer → merge → verify convergence

### Fixtures

Create `crates/pi-code-engine/tests/fixtures/` with sample files in each supported language (TypeScript, Rust, Python, Elixir) for deterministic testing.

---

## 12. Migration Checklist

1. [ ] Create `crates/pi-code-engine/` with Cargo.toml and module structure
2. [ ] Implement language profiles + build.rs generation
3. [ ] Implement CodeBuffer (rope + tree-sitter + loro + history)
4. [ ] Implement procedure DSL (builder + activation + selector + rules)
5. [ ] Implement structural edits (splice, drag, clone, transpose, replace)
6. [ ] Implement outline + resolution-aware read
7. [ ] Implement navigate (all actions + graph-aware references)
8. [ ] Implement diff (difftastic integration)
9. [ ] Add NAPI bindings in pi-natives for CodeBuffer commands
10. [ ] Refactor pi-code-graph to depend on pi-code-engine
11. [ ] Fix graph search/dead_code/clusters
12. [ ] Add diff-aware graph + incremental indexing
13. [ ] Migrate code tool routing from Emacs to NAPI
14. [ ] Add inline graph annotations to read output
15. [ ] Remove Emacs code tool registration
16. [ ] Update code.md prompt
17. [ ] Full test suite passes
