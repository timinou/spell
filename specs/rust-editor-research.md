# Rust Headless Editor Engine: Research on Buffer/Document Layers

## Executive Summary

Investigated five Rust editor/tool projects to understand best practices for:
1. Persistent buffer state with rope/CRDT implementations
2. Incremental tree-sitter parsing
3. Undo/redo (linear vs tree-based)
4. Concurrent multi-cursor editing
5. Structural diff generation
6. Extractable libraries

**Key Finding**: No single editor fully extracts all layers as reusable libraries. All tightly couple buffer, language, and UI layers. However, foundational patterns and published crates exist that can guide architecture.

---

## Project-by-Project Analysis

### 1. Zed Editor (zed-industries/zed)

#### Buffer Architecture: Four-Layer Stack
1. **Layer 1: Rope** — Custom SumTree implementation (not classic binary-tree rope)
   - B+ tree with leaf chunks and monoid-based summaries
   - O(log n) operations for insert, delete, substring
   - Copy-on-write with Arc reference counting
   - 128-byte chunks (configurable)
   - Fast snapshots: only increment Arc, no deep copy
   
2. **Layer 2: text::Buffer** — CRDT Operations
   - Operation-based CRDT with Lamport timestamps
   - Anchor system: stable position references surviving concurrent edits
   - Each inserted character has unique Locator identity
   - Undo/redo: transaction-based grouping, not tree
   - Linear undo/redo only (tree-based undo is open issue #17455)
   
3. **Layer 3: language::Buffer** — Language Features
   - Wraps text::Buffer
   - syntax_map: holds tree-sitter parse trees
   - Async incremental reparsing on edits
   - Emits Reparsed events
   - Diagnostic tracking
   
4. **Layer 4: MultiBuffer** — Multi-File Views
   - Excerpts aggregation of language::Buffer instances
   - Enables multi-buffer search, find/replace, diffs

#### Tree-Sitter Integration
- Incremental parsing: only re-parses regions intersecting edits
- Complex: must handle injection query changes
- Very fast: microsecond-scale typical
- Snapshot pattern: each Excerpt→Arc<language::BufferSnapshot>→text::BufferSnapshot→Rope

#### Undo/Redo
- **Linear model** only (not tree)
- Per-participant undo stacks (critical for collab editing)
- Operations: insert what was deleted, delete what was inserted
- Lamport clocks determine deterministic order
- Issue: tree-like history would need independent span+change storage

#### Concurrent Editing (CRDT)
- Conflict-free via Lamport timestamps + Locators
- Each character has unique ID that survives concurrent edits
- Edits expressed as logical locations, not byte offsets
- Multi-client via socket broadcast
- No explicit multi-cursor system visible (handled by per-user buffer state)

#### Library Extraction Status
- **NOT published as standalone crates**
- `rope`, `text`, `language` all in Zed repo
- Marked `publish = false` in Cargo.toml
- Tightly coupled to GPUI (Zed's UI framework)
- **Useful for study**: SumTree pattern, monoid-based summaries, Lamport CRDT
- **Not extractable as-is**: too many GPUI dependencies

---

### 2. Helix Editor (helix-editor/helix)

#### Buffer Architecture
- **Core**: ropey crate (published library, not custom rope)
- **Transactions**: OT-like (not full OT, simpler)
- **History**: Tree-based revision tracking

#### Rope Integration
- Uses published `ropey` crate (Rust's primary rope library)
- Cheap to clone (shared data)
- Modified via Transaction construction
- No custom wrapper beyond standard ropey API

#### Incremental Parsing
- **Syntax**: wraps tree_house::Syntax
- Handles tree-sitter incremental updates
- 500ms timeout to prevent blocking on large files
- **tree-house improvement**: efficient injection layer re-parsing (only re-parse changed injection layers)

#### Undo/Redo: Tree-Based
- **Revision tree** (not linear like Zed)
- Root revision at index 0 (dummy)
- Each revision has parent + optional last_child
- last_child implements redo chain
- Arbitrary revision jumping: computes lowest common ancestor (LCA), applies inversions back to LCA, then forward transactions

**Key advantage over Zed**: Supports full undo tree navigation — can branch after undo without losing progress

#### Concurrent Multi-Cursor
- Selections & Transactions abstractions
- Multi-cursor via Range/Selection types
- Transaction-based: all mutations flow through transactions (ensures everything is undoable)
- No explicit CRDT — single-user focused
- Transactions can be composed/mapped to update dependent positions

#### Library Extraction Status
- **Core is mostly extractable**
- helix-core crate published (though not on crates.io in primary distribution)
- Uses published ropey
- **Useful for study**: tree-based history with LCA computation, transaction inversion
- **Limitation**: tightly coupled to helix-term UI

---

### 3. Lapce Editor (lapce/lapce)

#### Buffer Architecture
- **Rope**: lapce-xi-rope crate (published library)
  - Based on Xi-Editor rope science
  - B-tree with leaf nodes at bottom
  - Atomic reference counting + copy-on-write
  - O(log n): insert, delete, substring
  - Immutable with CoW optimizations
  
#### RopeText Wrapper Layer
- Provides line/column navigation
- offset(line, col): validates better than line + col addition
- line(n): returns content with line ending (if exists)
- Avoids returning newlines, validates boundaries
- Cow string access: small ranges are references, large allocate

#### Concurrency Model
- UI/Proxy architecture (not peer-to-peer like Zed)
- lapce-app (GUI) ↔ lapce-proxy (backend)
- Edits apply locally on proxy, delta sent to app
- Rope copy-on-write: snapshots nearly free for async operations (autosave thread)
- Multi-cursor: Ctrl+Alt+Arrow, Alt+Shift+I, Ctrl+Shift+L

#### MapReduce Pattern (Xi Origin)
- Summary information maintained at each node
- On edit: recompute summaries only for changed nodes, bubble to root
- O(log n) per user action
- Enables efficient O(log n) seeking and slicing

#### Incremental Parsing
- No explicit research found on Lapce's tree-sitter integration
- Assumed similar to others: tree-sitter incremental updates

#### Library Extraction Status
- **lapce-xi-rope**: published and usable standalone
- RopeText wrapper: part of floem_editor_core (Lapce's UI library)
- **Useful for study**: xi-rope architecture, RopeText wrapper patterns
- **Limitation**: RopeText part of larger UI crate

---

### 4. tree-edit (ethan-leba/tree-edit)

#### Overview
- **NOT** a full editor — Emacs package for structural editing
- **Scope**: convert text into AST, manipulate AST, convert back to text
- **Status**: Inactive (maintainer focused on full-time work)

#### Architecture
Three-phase approach:
1. **Tree-sitter parsing**: Convert text to syntax tree
2. **Logic programming**: Reverse parser using miniKanren (Elisp)
3. **Grammar preprocessing**: Transform tree-sitter JSON grammars, compute node type relationships

#### Editing Operations
- **Insert**: assert new tokens to left/right of node (syntax auto-populates)
- **Delete**: remove node + surrounding syntax (can repopulate if needed)
- **Replace**: swap node for node-type (if parse succeeds)
- **Raise**: travel up parents, replace ancestor with current node
- **Slurp/Barf**: modify nesting structure
  - Slurp: move statements into containing structure
  - Barf: move statements out

#### Splice Operations
- Documented as "slurp" and "barf" (Lisp terminology)
- Splice-up: extract node out of current structure, preserve statements before/after
- Not explicit "splice/drag/clone" on arbitrary subtrees

#### Limitations & Grammar Issues
- Tree-sitter API/grammars **not designed for structural editing**
- Most grammars awkward or impossible to edit without hacks
- tree-edit uses **forked tree-sitter grammars** (custom modifications)
- Hidden nodes (prefixed _) cause false parse views
- Only 3 languages fully supported: Python ✅, C 🔨, Java 🔨

#### Library Extraction Status
- **NOT a library** — Emacs-only Elisp package
- **evil-tree-edit**: Keybindings + visualization layer (separate)
- **Useful for study**: Reverse parser with logic programming, grammar preprocessing strategy
- **Not reusable as Rust library**: Elisp-only, grammar-dependent

---

### 5. Difftastic (Wilfred/difftastic)

#### Purpose
- Structural diff tool (not editor)
- Input: two files → Output: syntax-aware diff
- Uses tree-sitter for parsing

#### Tree-Sitter Integration
Two-stage pipeline:
1. **Parse Tree Creation**: tree-sitter creates concrete syntax tree (CST)
2. **Simplified Syntax Tree**: Walk tree-sitter → convert to Syntax representation
   - Lists: delimited constructs (), [], {}
   - Atoms: indivisible tokens (strings, numbers, keywords)
   - Maintains only structural info needed for diffing

#### Structural Diff Algorithm
- Treats diffing as **graph problem**
- Uses **Dijkstra's algorithm** for optimal matching
- Syntax-aware: highlights which pieces changed
- Whitespace-intelligent: knows when it matters
- Line-free: handles reformatting correctly
- 30+ language support

#### Capabilities vs Limitations
**Capabilities**:
- Exact structural changes (not line-based)
- Reformatting detection (same syntax, different whitespace)
- Merge conflict handling (v0.50+)
- Syntax-aware matching
- Fallback: line-oriented diff for parse errors (configurable limit)

**Limitations**:
- Performance: scales poorly on files with many changes, high memory
- Output human-consumption only (no patches)
- Can't do merges (lossy from text perspective)
- Ignores reordering (order always significant)

#### Library Extraction Status
- **difftastic crate**: published on crates.io
- Can be used as standalone library
- **Useful for study**: Tree-sitter Syntax transformation, Dijkstra graph diff algorithm
- **Extractable**: yes, as dependency for structural diff needs

#### Delimiter Token Configuration
```rust
delimiter_tokens = [("(", ")"), ("{", "}"), ("[", "]")]
```
Treats delimiters as part of list structure, not atoms.

---

## Comparative Analysis

### Text Storage Approaches

| Editor | Rope Type | Snapshot Cost | CoW | Monoid Summaries | Published |
|--------|-----------|---------------|-----|-----------------|-----------|
| Zed | SumTree custom | Arc bump only | Yes | Yes (monoid) | No |
| Helix | ropey crate | Cheap clone | Yes | No | Partial |
| Lapce | xi-rope crate | Cheap clone | Yes | No (implicit) | Yes |
| Difftastic | N/A (diff only) | N/A | N/A | N/A | Yes |

### Undo/Redo Approaches

| Editor | Model | Per-Participant | Tree-Based | Jump to Arbitrary | Status |
|--------|-------|-----------------|------------|------------------|--------|
| Zed | Linear | Yes (via Locators) | No | No | Requested feature |
| Helix | Tree | Single-user | Yes | Yes (via LCA) | Implemented |
| Lapce | ? | ? | ? | ? | Not researched |

### Concurrent Editing Support

| Editor | Multi-Client | Mechanism | Cursor Handling |
|--------|-------------|-----------|-----------------|
| Zed | Yes | CRDT + Lamport timestamps | Per-participant |
| Helix | No | Single-user transactions | Multi-cursor selections |
| Lapce | Proxy model | UI/Proxy sync | Multi-cursor + delta |

### Incremental Parsing

| Editor | Implementation | Injection Handling | Timeout |
|--------|---|---|---|
| Zed | tree-sitter native | Handles, re-queries affected | Implicit |
| Helix | tree_house wrapper | tree-house improved (selective re-parse) | 500ms |
| Lapce | ? | ? | ? |

---

## Key Architectural Patterns Identified

### 1. Rope as Foundation
- **Consensus**: All editors use rope-like structures
- **Zed difference**: Custom SumTree with monoid summaries (more powerful for indexing)
- **Others**: Published ropey (simpler, adequate for most cases)
- **Insight**: Rope is non-negotiable for responsive large-file editing

### 2. Snapshot Pattern for Concurrency
- All enable cheap snapshots for async operations
- Zed's Arc+SumTree is most sophisticated
- Others rely on rope's built-in copy-on-write

### 3. Transaction-Based Undo
- **Zed**: Linear + CRDT (collaborative)
- **Helix**: Tree-based (single-user, optimal UX)
- **Insight**: Choice depends on collab requirements
  - Collab → linear (simpler semantics with concurrent ops)
  - Single-user → tree (best UX, jump anywhere)

### 4. Language Intelligence Delay
- All parse asynchronously in background
- None block on slow parses
- Events/watches notify when parse complete

### 5. Grammar Customization Required
- tree-edit learns hard way: standard grammars not ideal for structural ops
- Difftastic: uses unmodified grammars (goal is analysis, not editing)
- **Insight**: Structural editing requires grammar tweaks; structural diffing doesn't

### 6. No Extraction/Modularity
- **Major finding**: Even in open-source editors, buffer layers tightly coupled to UI frameworks
- Zed: GPUI dependency
- Helix: helix-term integration
- Lapce: floem (Rust UI framework) integration
- **Exception**: Published crates (ropey, tree-sitter, difftastic) are well-scoped

---

## Extractable Components (For Reuse)

### Tier 1: Published Crates (Production-Ready)
1. **tree-sitter** (v0.26.8+)
   - Incremental parsing
   - Injection support
   - Language grammars available

2. **ropey** (v1.6.1+)
   - Rope data structure
   - O(log n) operations
   - Cheap clones

3. **difftastic** (published, can be dependency)
   - Structural diff algorithm
   - Tree-sitter integration

### Tier 2: Patterns to Study (Not Directly Reusable)
1. **Zed's SumTree + monoid pattern**
   - Gives O(log n) multi-dimensional indexing
   - Useful if performance bottleneck on Rope operations
   - Would require custom implementation

2. **Helix's tree-based history with LCA**
   - Optimal for single-user editors
   - Clean undo tree UX
   - Applicable if multi-user not required

3. **Zed's CRDT + Lamport timestamps**
   - Required for true collaborative editing
   - Complex but proven approach
   - Learning curve steeper than tree-based

### Tier 3: Known Gaps
- **No library**: Rope + incremental parser + undo/redo + multi-cursor all together
- **No library**: CRDT buffer integration
- **No library**: Async language server integration (LSP)

---

## Recommendations for Headless Editor Engine

### Architecture Strategy

1. **Rope Layer**: Use published `ropey` crate
   - Mature, tested, adequate performance
   - Unless you hit its performance limits, custom SumTree not worth complexity

2. **Parser Layer**: tree-sitter + custom async wrapper
   - Incremental parsing is tree-sitter's domain
   - Consider `tree-house` pattern (Helix) for injection efficiency

3. **Buffer Layer**: Choose undo model first
   - **Single-user agents** → Helix's tree-based history (better UX for agent timeline)
   - **Multi-agent concurrent** → Zed's CRDT approach (but complexity)
   - **Hybrid** → Linear history + snapshot capability (simpler than tree-based, simpler than CRDT)

4. **Diff Layer**: Integrate difftastic
   - Use as library (published crate)
   - Solves structural diff problem

5. **Language Intelligence**: Async background tasks
   - Don't block editing on parse
   - Emit events when parse/analysis complete

### Anti-Patterns to Avoid

1. **No tree-edit approach** (Emacs-only, logic programming)
   - Requires grammar forks
   - Elisp infrastructure overhead
   - Consider only if Emacs-first requirement

2. **No monolithic UI+buffer layer**
   - Even studying Zed: extract concepts, not code
   - UI framework coupling is real pain point

3. **No "just use Zed's code"**
   - Zed's crates have `publish = false`
   - Heavy GPUI coupling
   - Not designed as library

### Concrete Stack Suggestion

```
headless-editor-core/
├── rope layer: ropey crate
├── parser layer: tree-sitter + custom incremental wrapper
├── buffer layer: custom impl (tree-based history OR simple linear)
├── diff layer: difftastic crate
└── language-server: async tokio tasks (LSP protocol)
```

**Rationale**:
- Each layer has clear responsibility
- Use published crates where available
- Custom code only where requirements diverge
- No UI coupling (headless)
- Testable in isolation

---

## Research Gaps & Unknowns

1. **Lapce's tree-sitter integration**: No detailed public docs found
2. **tree-edit's splice operations**: Limited documentation on arbitrary tree manipulation
3. **Multi-cursor transaction handling**: How Helix maps multi-cursor ops to single transaction
4. **Performance benchmarks**: No direct rope performance comparisons found
5. **Injection layer caching**: How much difftastic optimizes injection diffs

---

## Sources

- [Zed Blog: Rope & SumTree](https://zed.dev/blog/zed-decoded-rope-sumtree)
- [Helix Architecture Docs](https://github.com/helix-editor/helix/blob/master/docs/architecture.md)
- [tree-edit Documentation](https://github.com/ethan-leba/tree-edit/tree/main/doc)
- [Difftastic Manual](https://difftastic.wilfred.me.uk/)
- [Zed Github: Buffer Architecture](https://deepwiki.com/zed-industries/zed/4.3-pane-management)
- [Helix Github: Tree-sitter Integration](https://deepwiki.com/helix-editor/helix/4.2-tree-sitter-integration)
- [Lapce Github](https://github.com/lapce/lapce)
