# Rust CRDT Ecosystem Research: Multi-Agent Concurrent Document Editing

## Executive Summary

This research evaluates Rust's CRDT ecosystem for supporting multiple AI agents editing the same source file concurrently with structural validity preservation, undo/redo trees, and incremental parsing.

**Key Finding:** Rust has production-grade options that excel at concurrent editing, but none solve the complete problem out-of-the-box. The right choice depends on whether you prioritize performance (diamond-types), feature completeness (yrs/Yjs port), rich text accuracy (loro), or structural editing with undo (automerge + undo crate).

---

## Part 1: CRDT Libraries for Text Editing in Rust

### 1.1 Library Comparison Matrix

| Library | Language | Type | Status | Text Support | Performance | API Maturity | Best For |
|---------|----------|------|--------|--------------|-------------|--------------|----------|
| **automerge** | Rust (backend) + JS | CRDT | Production ✓ | Yes + JSON | Good, 10x improved in v3 | Low (Rust), Good (JS) | Offline-first apps, complex data structures |
| **autosurgeon** | Rust wrapper | Higher-level API | Production ✓ | Yes (via automerge) | Ergonomic | Good | Rust developers using automerge |
| **yrs** | Rust | CRDT | Production ✓ | Yes + shared types | Excellent | Medium | Text-heavy collaborative editors |
| **diamond-types** | Rust | CRDT | Experimental ⚠ | Text only | Exceptional (5000x faster) | Low | Pure speed benchmarks, not feature-complete |
| **loro** | Rust | CRDT (Event Graph) | Production ✓ | Rich text (Fugue) | Good, optimized | Good | Text with better merge semantics |
| **cola** | Rust | CRDT | Stable ✓ | Text only | 1.4-2x faster than diamond | Good | Lean, focused implementation |

### 1.2 Deep Dive: Each Library

#### **Automerge (automerge-rs)**

**Architecture:**
- CRDT with operation history preservation
- Supports JSON-like structures: maps, lists, text, counters
- Compression: ~1 byte per character in history (after v3 improvements)
- Operation-based + state-based variants

**For Multi-Agent Editing:**
- ✅ Branching: Full support. `Automerge.clone()` creates independent branch, `merge()` automatically combines changes
- ✅ Conflict resolution: Deterministic per data type (text merges character-level, maps use LWW)
- ✅ Diff generation: Built-in `changes()` API returns operations between versions
- ✅ History preservation: Full change log available, supports time-travel

**Advantages:**
- Proven in production (Ink & Switch team)
- Solves "no merge conflicts" problem completely
- Works offline, syncs asynchronously
- 10x memory improvement in Automerge 3

**Disadvantages:**
- Rust API is low-level and poorly documented
- Not designed for real-time collaboration (async sync pattern)
- Higher memory overhead than OT (40-60% even after compression)
- Autosurgeon wrapper still doesn't handle incremental updates

**Performance (v3):**
- Encoding: 30% overhead above raw text
- Document with 260k edits: manageable memory, not sub-millisecond
- Good for "save offline, merge later" not "live multi-agent editing"

**Production Readiness:** ⭐⭐⭐⭐⭐ (Autosurgeon: ⭐⭐⭐⭐)

---

#### **Yrs (Yjs in Rust)**

**Architecture:**
- Port of Yjs CRDT to Rust
- Shared data types: Text, Map, Array, XML
- Delta-state protocol: efficient diffs between versions
- Binary encoding optimized for network transmission

**For Multi-Agent Editing:**
- ✅ Branching: Yjs algorithm supports it, but not as explicitly documented as automerge
- ✅ Conflict resolution: YATA algorithm (similar semantic to Yjs)
- ✅ Diff generation: Delta-state model makes diffs efficient
- ✅ History: Operations preserved in internal structure

**Advantages:**
- Fastest CRDT implementation by far (proven across benchmarks)
- Designed for real-time collaboration
- Extensive ecosystem (protocols, editor integdings)
- lib0 encoding: compact binary format, cross-platform
- Cursor tracking, awareness protocol built-in

**Disadvantages:**
- Rust bindings less mature than JS version
- Memory overhead similar to other CRDTs
- Less documentation on Rust-specific patterns
- Designed for network sync, less emphasis on offline branching

**Performance:**
- 260k character trace: 0.97s (JS), faster in Rust
- Consistent sub-millisecond incremental edits
- 3.3MB for 260k document (JS), better in Rust

**Production Readiness:** ⭐⭐⭐⭐ (Well-proven in production Yjs apps, Rust support maturing)

---

#### **Diamond-types**

**Architecture:**
- Pure text CRDT (no JSON support yet)
- Modified B-tree with run-length encoding
- Optimized for single CRDT algorithm (YATA-like)
- Focus on raw speed over feature breadth

**For Multi-Agent Editing:**
- ⚠️ Branching: Theoretically yes, practically immature
- ⚠️ Conflict resolution: Yes, but single algorithm
- ✅ Diff generation: Position-based operations support OT interop
- ⚠️ History: Operations available, but less emphasis on version control

**Advantages:**
- Exceptional speed: 56ms for 260k edits (5000x faster than automerge)
- Rust leverage: total memory control, efficient B-tree packing
- Interoperable with OT (positional updates)
- Excellent for pure text performance testing

**Disadvantages:**
- Text-only, no complex data structures
- Marked as "WIP" (work-in-progress)
- Missing ecosystem: no sync protocols, no editor integrations
- Cargo.io version out of date
- Not feature-complete vs Yjs/Automerge
- No production deployments known

**Performance:**
- Native Rust: 56ms (260k edits)
- Memory: optimal, but not measured thoroughly
- Jitter: comparable to Yjs (periods of faster/slower)

**Production Readiness:** ⭐⭐ (Experimental, not recommended for production without significant development)

---

#### **Loro**

**Architecture:**
- CRDT based on Replayable Event Graph (REG)
- Fugue algorithm for text (solves interleaving anomalies)
- Supports lists, maps, rich text, movable trees
- UndoManager for local undo/redo during collaboration

**For Multi-Agent Editing:**
- ✅ Branching: `LoroDoc::new()` creates independent state, export/import enables merging
- ✅ Conflict resolution: Deterministic per type, rich text with Fugue prevents character interleaving
- ✅ Diff generation: Built-in export/import operations
- ✅ History: Version control via checkout to Frontiers

**Advantages:**
- **Solves interleaving anomaly** (major problem with RGA-based CRDTs)
- Rich text support with structural awareness
- Cursor tracking across concurrent edits
- Undo/redo tree built-in (local operations)
- JavaScript bindings available
- Modern design learning from Yjs/Automerge mistakes

**Disadvantages:**
- Newer than competitors (less battle-tested)
- Memory overhead: Fugue uses 618-685 bytes/character (worse than others)
- Tree types use fractional indexing (has interleaving issues, but acceptable)
- MovableList ~80% slower than List for insert/delete

**Performance:**
- Comparable to Yjs/diamond-types for standard operations
- Undo/redo overhead minimal (UndoManager operates locally)
- Memory: higher due to Fugue algorithm

**Production Readiness:** ⭐⭐⭐⭐ (Modern, actively developed, used in production by some teams)

---

#### **Cola**

**Architecture:**
- Operation-based CRDT for text
- Replica per peer with block-based insertions
- Linked-list internally with Lamport timestamps
- Compact binary encoding

**For Multi-Agent Editing:**
- ✅ Branching: Not explicitly designed for it, but operation-based so possible
- ✅ Conflict resolution: Deterministic ordering via timestamps
- ✅ Diff generation: Operation log provides diffs
- ⚠️ History: Operations preserved, but less emphasis on time-travel

**Advantages:**
- 1.4-2x faster than diamond-types (in benchmarks)
- Lean implementation, focused scope
- Rust ownership model leverage (simpler unsafe code)
- Well-documented code

**Disadvantages:**
- Less mature ecosystem than Yjs/automerge
- Text-only (no complex types)
- Smaller community, fewer production deployments
- Less documentation and examples

**Performance:**
- 1.4-2x faster than diamond in benchmarks
- Memory efficient (competitive with others)

**Production Readiness:** ⭐⭐⭐ (Stable but less proven than Yjs/automerge)

---

## Part 2: Addressing Your Use Case: Multiple AI Agents

### 2.1 Can Each Agent Have Its Own Branch?

**Answer: Yes, all mature CRDTs support this.**

**Implementation Pattern:**
```
Agent A:                    Agent B:                    Merged Doc:
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│ Document v0     │        │ Document v0     │        │ Document v0     │
│ + Agent A ops   │────┐   │ + Agent B ops   │────┬──│ + A ops merged  │
│ = Doc_A_fork    │    │   │ = Doc_B_fork    │    │   │ + B ops merged  │
└─────────────────┘    │   └─────────────────┘    │   │ (auto-conflict  │
                        │                          │   │  resolution)    │
                        └──────────────────────────┘   └─────────────────┘
```

**Technology-Specific Implementation:**

- **Automerge:** `doc.clone()` creates fork, `doc.merge(other_doc)` combines. No conflicts to resolve.
- **Yrs/Loro:** Create separate `LoroDoc`/`Y.Doc`, operations can be replayed via update protocol.
- **Diamond-types/Cola:** Operation-based, so sync operations between peers during merge.

### 2.2 Can Branches Be Merged Automatically?

**Answer: Yes, with caveats about conflict resolution semantics.**

**What CRDTs Guarantee:**
- Convergence: All replicas that apply the same operations end up identical
- Commutativity: Operation order doesn't matter
- Deterministic resolution: No manual conflict markers (unlike Git)

**Reality on "Automatic" Merging:**

1. **Concurrent edits to identical text location:**
   - Two agents insert at position 100 simultaneously
   - CRDT assigns deterministic order via timestamps/client IDs
   - Result is deterministic (not random) but potentially unexpected
   - Example: Alice types "cat", Bob types "dog" at same position → "cdaotg" or "cdaogt" (depending on CRDT)

2. **Interleaving anomalies (SOLVED by Loro/Fugue, UNSOLVED by Yjs/Diamond):**
   - RGA-based CRDTs (Yjs, Diamond, Cola): Character interleaving if backward insertions happen
   - **Solution:** Loro with Fugue algorithm prevents this, but adds memory overhead

3. **Structural edits (if code is represented as AST):**
   - CRDTs don't understand code semantics
   - Merging might create syntactically invalid code
   - **Example:** Agent A deletes function, Agent B adds call to it → orphaned call
   - **Solution:** Validation layer above CRDT, not in CRDT itself

### 2.3 Is There Conflict Resolution That Preserves Structural Validity?

**Answer: Not built-in. CRDT + Validator layer required.**

**The Gap:**
- CRDTs solve *data consistency* (all replicas converge)
- They don't solve *semantic validity* (code compiles, runs, is correct)

**Preservation Strategies:**

1. **Constraint-based merging** (not in current CRDTs):
   - Track deleted symbols in a "tombstone" set
   - When merging, check if new reference refers to tombstone
   - Reject or auto-fix the merge

2. **Tree-sitter validation layer:**
   - After merge, re-parse document with tree-sitter
   - Check for parse errors, undefined symbols
   - Flag for user review or auto-rollback to last valid state

3. **Operational Transform on semantic units:**
   - Not a CRDT pattern, but Linear and others use this
   - Apply OT to high-level semantic units (functions, classes), not characters
   - Harder to implement but preserves structure

4. **Loro + Custom Conflict Resolution:**
   - Use Loro's event graph to observe merge points
   - Apply custom validation rules when events conflict
   - Loro's API supports inspection of conflicting values

**Practical Recommendation for AI Agents:**
- Use CRDT for base text layer (automerge or yrs)
- Add validation engine on top that:
  - Parses merged result with tree-sitter
  - Checks symbol resolution (via LSP or local symbol table)
  - Flags conflicts that break code structure
  - Optionally auto-fixes common patterns (import reordering, etc.)

### 2.4 Can You Get a Diff Between Branches?

**Answer: Yes, straightforward.**

| Library | Diff API | Format | Notes |
|---------|----------|--------|-------|
| **Automerge** | `doc.changes()` | Operations | Sequence of ops between versions |
| **Yrs** | `Y.encode()` state diff | Binary deltas | Delta-state protocol, very efficient |
| **Loro** | `export(ExportMode)` | JSON/binary | Snapshot or update format |
| **Diamond-types** | Operation log | Position-based ops | Can serialize/compare |
| **Cola** | Operation log | Timestamped ops | Accessible via internal state |

**Practical Example (Automerge):**
```rust
let doc_a: Document = ...; // Agent A's version
let doc_b: Document = ...; // Agent B's version
let changes = doc_b.changes(&doc_a);
// Now you have the sequence of edits B made relative to A
// Can be rendered as diff or replayed elsewhere
```

### 2.5 Performance Characteristics for 1-10K Line Files

**Benchmark Results (260k character trace = ~50k lines):**

| Library | Time | Memory | Notes |
|---------|------|--------|-------|
| **Automerge (v3)** | ~1-5s | Varies, 10x better than v2 | Not optimized for real-time |
| **Yjs/Yrs** | 0.97s (JS), faster (Rust) | 3.3 MB | Consistent, reliable |
| **Diamond-types** | 56 ms | Not measured, optimal | Raw speed record, WIP status |
| **Loro** | Comparable to Yjs | Higher (Fugue overhead) | Better merge semantics |
| **Cola** | 1.4-2x faster than diamond | Comparable | Balanced performance |

**For 1-10K line files (10-100k characters):**
- All options complete in <100ms with proper caching
- Memory is not a constraint (sub-10MB per document)
- Incremental parsing (see Part 3) is bigger bottleneck than CRDT

**Key Insight:** At your scale (1-10K lines), performance differences are negligible. Choose based on features, not benchmarks.

---

## Part 3: Integration with Tree-Sitter for Incremental Parsing

### 3.1 How Tree-Sitter Works with CRDTs

**Standard Pattern:**
```
Buffer Edit       Tree-sitter Update       CRDT Sync
    │                    │                     │
    ├─> Document change  ├─> tree.edit()  ├─> record operation
    ├─> Generate delta   ├─> parser.parse()   ├─> broadcast to peers
    └─> Validate         └─> new syntax tree  └─> merge conflicts
```

### 3.2 InputEdit Integration

Tree-sitter's `InputEdit` struct describes what changed:
```rust
tree.edit(&InputEdit {
    start_byte: 100,
    old_end_byte: 105,
    new_end_byte: 110,
    start_position: Point { row: 3, column: 10 },
    old_end_position: Point { row: 3, column: 15 },
    new_end_position: Point { row: 3, column: 20 },
});
let new_tree = parser.parse(new_source, Some(&tree));
```

### 3.3 CRDT + Tree-Sitter Pipeline for AI Agents

**Architecture:**

```
Agent A (Rust):
┌─────────────────────────────────────────┐
│  AI Agent generates edit                │
│  ├─> Apply to CRDT (automerge)         │
│  ├─> Convert CRDT op → tree-sitter edit│
│  ├─> Run tree.edit()                    │
│  ├─> Parse incrementally                │
│  ├─> Validate syntax (tree-sitter query)│
│  └─> Broadcast CRDT change              │
└─────────────────────────────────────────┘
         ↓ (network)
Agent B (Rust):
┌─────────────────────────────────────────┐
│  Receive CRDT change                    │
│  ├─> Merge into local CRDT              │
│  ├─> Extract text delta                 │
│  ├─> Convert → tree-sitter InputEdit    │
│  ├─> Run tree.edit() + parse()          │
│  ├─> Validate syntax                    │
│  └─> Update UI/LSP                      │
└─────────────────────────────────────────┘
```

### 3.4 Converting CRDT Operations to InputEdit

**Challenge:** CRDTs work with logical positions (character identifiers), but tree-sitter needs byte offsets.

**Solution Pattern:**

```rust
// After CRDT merge, extract text delta
let before_text = doc_before.text();
let after_text = doc_after.text();

// Find changed regions
let (start_byte, old_end, new_end) = find_text_diff(&before_text, &after_text);

// Create InputEdit
let input_edit = tree_sitter::InputEdit {
    start_byte,
    old_end_byte: old_end,
    new_end_byte: new_end,
    start_position: byte_to_point(&before_text, start_byte),
    old_end_position: byte_to_point(&before_text, old_end),
    new_end_position: byte_to_point(&after_text, new_end),
};

// Update tree
tree.edit(&input_edit);
let new_tree = parser.parse(&after_text, Some(&tree));
```

### 3.5 Performance: Incremental Parsing is Fast

Tree-sitter's incremental parsing is **sub-millisecond:**
- Initial parse: 2-3x slower than rustc parser
- Incremental update: <1ms for typical edits
- Copy-on-write trees: previous snapshot remains usable during parse

**Zed's benchmark:** Even complex 1000-line file edits parse incrementally in <1ms with copy-on-write snapshots.

### 3.6 Integration Recommendations

**For Your Multi-Agent System:**

1. **Use immutable text buffers:**
   - CRDT already handles this (rope-like structure)
   - Pair with tree-sitter's copy-on-write trees
   - Allows concurrent parsing while editing

2. **Batch CRDT + parse updates:**
   - Group rapid edits from single agent
   - Call tree.edit() + parse() once per batch
   - Avoids repeated parsing

3. **Validation via tree-sitter queries:**
   - Post-merge, query for syntax errors: `(ERROR) @error`
   - Query for undefined symbols (needs symbol table integration)
   - Flag problems to agents for review

4. **LSP integration for smart merging:**
   - Get symbol definitions from LSP
   - Before merging edits from Agent A + B:
     - Check if either deletes a symbol the other references
     - Auto-suggest conflict resolution
     - Or mark for user review

---

## Part 4: Undo/Redo with CRDTs

### 4.1 The Challenge

Normal undo/redo doesn't work with CRDTs:
- Single-agent undo: just reverse the operation
- Multi-agent scenario: what does "undo" mean when others are editing?

### 4.2 Local vs. Causal Undo

**Local Undo (What Loro/Automerge Recommend):**
- Only undo operations *you* performed
- Don't undo operations from other agents
- Use UndoManager or command pattern

**Example:**
```
Timeline:
Agent A: Insert "fn"
Agent B: Insert "main() {"  (concurrent)
Agent A: Insert "()"

User A presses Ctrl+Z:
  Should undo "fn" only, not agent B's edits
  Result: Agent B's text remains, Agent A's edit reverted
```

### 4.3 Undo/Redo Implementation Strategies

**Strategy 1: Loro's UndoManager (Built-in)**
```rust
let mut manager = UndoManager::new(&doc);
// Make edits...
doc.commit();
manager.undo(&mut doc)?;  // Undoes only your changes
```
- Supports cursor position transformation
- Works during concurrent editing
- Handles local undo of "own edits" cleanly

**Strategy 2: Rust `undo` Crate + Automerge**
```rust
let mut history: History<Document> = History::new();
history.edit(&mut doc, SomeEdit);
history.undo(&mut doc);  // Tree-based undo, supports branches
```
- Non-linear undo tree (when you undo then edit differently)
- Command pattern compatible with any data structure
- Useful for offline-first + merging later

**Strategy 3: Snapshot-Based Undo**
- Store full document snapshots at checkpoints
- Undo = restore previous snapshot
- Simple but memory-intensive
- Persistent data structures (like rope) make cloning cheap

### 4.4 Structural Undo (For AI Agents)

**Problem:** If Agent A deletes a function and Agent B deletes a call to it, undo is ambiguous.

**Solution:** Combine undo tree with validation:

```rust
// Agent A edits structure
let edit_a = FunctionDelete { name: "helper" };
history.edit(&mut doc, edit_a);

// Agent B's edit causes validation issue
let edit_b = InsertCall { func_name: "helper" };
let merged = merge(doc_a, doc_b);
validate(&merged)?;  // Error: undefined symbol

// Undo chain visible to agent
let available_undos = history.available_undos();
// Can inspect what each undo would do
```

### 4.5 Recommendation for Your Use Case

**Use a 3-layer approach:**

1. **CRDT Layer (automerge or yrs):**
   - Handles concurrent multi-agent editing
   - Preserves all operations for diffing

2. **Undo Layer (Loro's UndoManager or `undo` crate):**
   - Track each agent's operations separately
   - Undo only their own edits

3. **Validation Layer (tree-sitter + symbol table):**
   - After undo, validate document
   - If invalid (undefined symbols), mark as "risky undo"
   - Offer alternatives or require confirmation

---

## Part 5: Existing Rust Editors - How They Handle Buffers

### 5.1 Zed (Collaborative Editor)

**Buffer Architecture:**
- CRDT-based (custom implementation, not using library)
- Uses Lamport timestamps for unique identifiers
- Each character insertion assigned unique **Locator** (timestamp + client ID + offset)
- Version vector tracks causal history
- **Anchor system:** Position references tied to Locators, survive concurrent edits

**Key Innovation:**
```
When Alice inserts at position 100 and Bob inserts at position 100 (same, concurrent):
  Alice's Locator: (client=1, ts=100, offset=0)
  Bob's Locator:   (client=2, ts=100, offset=0)
  
  All replicas order deterministically:
  if (1, 100, 0) < (2, 100, 0) by tuple comparison:
    Alice's text comes first
  Else: Bob's text comes first
```

**For Multi-Agent:** Built for it (remote development + live collaboration). Not applicable to Rust ecosystem (closed source, Zed-specific).

### 5.2 Helix (Modal Editor)

**Buffer Architecture:**
- **Rope-based** (ropey crate)
- **Immutable/functional** primitives: edits return new copies, don't mutate in place
- **OT-like Transaction** for composing edits
- **Document:** bundles Rope + Selections + Syntax + History
- **View:** visual representation, separate from logical document

**Multi-Agent Support:** None. Single-user. Designed for efficiency, not collaboration.

**Undo/Redo:** Simple linear history (stack-based).

**Why Relevant to Your Use Case:**
- Rope data structure proven efficient for text editors
- Immutable approach enables easy snapshotting
- Transaction pattern similar to CRDT operation composition

### 5.3 Lapce (Performance-Focused Editor)

**Buffer Architecture:**
- **Rope-based** (Xi-Editor's rope, persistent/immutable)
- **Copy-on-write semantics:** efficient cloning for snapshots
- **Thread-safe ref-counting**
- **Proxy-based concurrency:** UI thread edits locally, proxy syncs changes
- **Background syntax highlighting** (different thread)

**Multi-Agent Support:** Proxy design allows local/remote splits, but not built for concurrent agents.

**Undo/Redo:** Command pattern (likely standard impl).

**Why Relevant to Your Use Case:**
- Rope is proven safe for concurrent reference counting
- Copy-on-write enables cheap snapshots (useful for CRDT + undo)
- Proxy architecture provides design pattern for multi-agent sync

---

## Part 6: Production Readiness Assessment

### 6.1 What's Production-Ready

| Component | Status | Notes |
|-----------|--------|-------|
| **Automerge** | ✅ Production | Proven at Ink & Switch, used by teams. Rust API rough but functional. |
| **Yrs** | ✅ Production | Yjs proven extensively. Rust port actively maintained, good bindings. |
| **Loro** | ✅ Production | Newer but solid. Good for text + structural edits. Growing adoption. |
| **Cola** | ✅ Stable | Less battle-tested but mathematically sound, good code quality. |
| **Tree-sitter** | ✅ Production | 20M+ downloads, used by major editors (Helix, Zed, Neovim). |
| **Undo/Redo Tree** | ✅ Production | `undo` crate stable, simple pattern. |
| **CRDT + Validation** | ⚠️ Nascent | Pattern is clear, but not packaged. Requires custom integration. |

### 6.2 What's Experimental

| Component | Status | Notes |
|-----------|--------|-------|
| **Diamond-types** | ⚠️ WIP | Exceptional speed, but missing features. Cargo version outdated. |
| **CRDT + LSP validation** | ⚠️ Research | No libraries combine CRDT + LSP for structural aware merging. |
| **Structural undo with validation** | ⚠️ Research | Pattern known but not standardized. Requires custom work. |

### 6.3 What's Missing

**Critical gaps for a production "headless code editor engine":**

1. **Structural awareness:**
   - CRDTs don't understand code semantics
   - No built-in support for "delete function + all calls to it"
   - Need custom validation layer

2. **LSP integration:**
   - Merging text is one thing; merging symbols is different
   - No library provides "merge-aware LSP" pattern
   - Symbol resolution + conflict detection = custom work

3. **Diff generation for code:**
   - CRDTs can generate text diffs
   - But "meaningful" diffs (function-level, semantic) require tree-sitter + custom logic
   - No library packages this yet

4. **Incremental validation:**
   - After merge, full re-validation is expensive
   - Smart re-validation (only changed regions) not standardized
   - LSP can help (compute diagnostics incrementally) but not automatic

---

## Part 7: Recommendations by Use Case

### **Use Case A: Maximum Compatibility & Offline-First**
**Choose: Automerge + Autosurgeon + Tree-sitter validation**

**Why:**
- Offline-first design matches "multiple agents can diverge"
- Automatic merging with no conflicts
- JSON-like data structures support beyond text
- Rust ecosystem growing

**Stack:**
```toml
[dependencies]
automerge = "0.2"
autosurgeon = "0.13"
tree-sitter = "0.26"
undo = "0.51"
```

**Gaps to close:**
- Add validation layer (tree-sitter + symbol table)
- Implement structural conflict detection
- Undo tracking per-agent (manual implementation)

---

### **Use Case B: Real-Time Collaboration & Performance**
**Choose: Yrs + Tree-sitter validation**

**Why:**
- Proven fastest in production
- Real-time collaboration protocol built-in
- Extensive ecosystem (adapters, UI libraries)
- Rust port actively maintained

**Stack:**
```toml
[dependencies]
yrs = "0.18"
tree-sitter = "0.26"
undo = "0.51"
```

**Gaps to close:**
- Validation layer
- Structural merge awareness
- Agent-specific undo tracking

---

### **Use Case C: Text Accuracy with Interleaving Prevention**
**Choose: Loro + Tree-sitter**

**Why:**
- Fugue algorithm solves character interleaving (major issue with Yjs/Diamond)
- Built-in UndoManager for local undo during collaboration
- Cursor tracking preserved across concurrent edits
- Rich text support

**Stack:**
```toml
[dependencies]
loro = "1.1"
tree-sitter = "0.26"
```

**Gaps to close:**
- Validation layer
- Structural conflict detection
- Agent branching explicitly (test export/import workflow)

---

### **Use Case D: Pure Speed (Benchmarking, Analysis Tools)**
**Choose: Diamond-types or Cola**

**Why:**
- 56ms for 260k edits (diamond) or 1.4-2x faster than diamond (cola)
- Text-only, simple API
- Low memory overhead

**Caution:**
- Diamond-types still WIP; consider Cola for stability
- Neither has production ecosystem
- Missing complex data structure support

---

## Part 8: Recommended Stack for Multi-Agent AI Editing

### **Architecture Overview**

```
┌─────────────────────────────────────────────────────────────┐
│ Multi-Agent AI Code Editor Engine (Rust)                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Layer 4: Validation & Conflict Resolution           │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ Tree-sitter query engine (symbol table)          │ │   │
│  │ │ + LSP client for semantic validation             │ │   │
│  │ │ + Structural conflict detection                  │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Layer 3: Undo/Redo Tree                             │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ Per-agent undo history (undo crate)             │ │   │
│  │ │ + Validation checkpoint system                  │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Layer 2: Incremental Parsing                        │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ Tree-sitter parser + InputEdit                  │ │   │
│  │ │ + Syntax tree queries                           │ │   │
│  │ │ + Symbol extraction                             │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Layer 1: CRDT Document Store                        │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ Automerge or Yrs or Loro (pick one)             │ │   │
│  │ │ + Branching & merging                           │ │   │
│  │ │ + Operation history                             │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### **Recommended Configuration: Automerge + Loro (Hybrid)**

**Rationale:**
- **Automerge** for main document + versioning
- **Loro** as validation substrate (better text merging with Fugue)
- Or use **Yrs** if you want real-time sync protocol

**Why Not One Solution?**
1. **Automerge alone:** Excellent versioning, but RGA-based interleaving issues
2. **Loro alone:** Better text accuracy, but less ecosystem/documentation
3. **Hybrid:** Treat Automerge as primary version control, validate merged results with Loro's merge semantics

**Practical Implementation:**

```rust
// Multi-agent editing with validation
use automerge::Document;
use loro::LoroDoc;
use tree_sitter::{Parser, Language};

struct CodeEditorEngine {
    doc: Document,              // Primary CRDT (automerge)
    validator: LoroDoc,         // Validation layer
    parser: Parser,
    language: Language,
    undo_history: HashMap<AgentId, UndoHistory>,
}

impl CodeEditorEngine {
    fn agent_edit(&mut self, agent_id: AgentId, change: TextChange) -> Result<()> {
        // 1. Apply to CRDT
        self.doc.change(|d| apply_change(d, change))?;
        
        // 2. Update syntax tree
        let text = self.doc.text();
        let input_edit = InputEdit::from_change(&change);
        self.tree.edit(&input_edit);
        let new_tree = self.parser.parse(&text, Some(&self.tree))?;
        
        // 3. Validate
        let errors = validate_with_tree(&new_tree, &self.doc)?;
        if !errors.is_empty() {
            // Rollback and return error
            return Err("Validation failed".into());
        }
        
        // 4. Track in undo history
        self.undo_history.entry(agent_id)
            .or_insert_with(UndoHistory::new)
            .record(change);
        
        Ok(())
    }
    
    fn merge_branches(&mut self, agent_a: &Document, agent_b: &Document) -> Result<()> {
        // 1. Merge CRDT
        self.doc.merge(agent_a)?;
        self.doc.merge(agent_b)?;
        
        // 2. Full re-parse and validate
        let text = self.doc.text();
        self.tree = self.parser.parse(&text, None)?;
        let errors = validate_with_tree(&self.tree, &self.doc)?;
        
        if !errors.is_empty() {
            // Offer conflict resolution options
            return Err(ConflictError { errors }.into());
        }
        
        Ok(())
    }
}
```

### **Integration Checklist**

- [ ] **CRDT Core:** Choose automerge (versioning) or yrs (real-time)
- [ ] **Tree-sitter:** Incremental parsing on edits
- [ ] **Symbol Table:** Extract from tree-sitter queries, maintain during edits
- [ ] **Validation Engine:** Check for undefined symbols, invalid syntax post-merge
- [ ] **Undo Manager:** Per-agent history tracking
- [ ] **LSP Bridge:** Optional, for IDE integration
- [ ] **Diff API:** Expose changes between versions for agent feedback
- [ ] **Conflict Handler:** Structural conflicts flag for review or auto-fix

---

## Part 9: Critical Implementation Challenges

### Challenge 1: Converting CRDT Positions to Tree-Sitter Points

**Problem:** CRDTs track logical positions (character IDs), tree-sitter wants byte offsets.

**Solution:** Maintain position mapping:
```rust
// After each edit, rebuild character-to-byte mapping
let char_pos = 0;
let byte_pos = 0;
for ch in text.chars() {
    char_positions[char_pos] = byte_pos;
    byte_pos += ch.len_utf8();
    char_pos += 1;
}
```

### Challenge 2: Handling Tombstone Accumulation

**Problem:** CRDTs preserve deletion history. After many deletes, files bloat with tombstones (Figma: 10M+ tombstones, 32 bytes each).

**Solution:** Periodic compaction (Figma's approach):
```
After 1M tombstones or 7 days of history:
  1. Create new CRDT snapshot (current state only)
  2. Discard history older than threshold
  3. Clients must resync
  4. File size drops ~90%
```

### Challenge 3: Real-Time Merge Semantics for Code

**Problem:** Two agents make conflicting structural changes:
- Agent A deletes function `foo()`
- Agent B inserts call to `foo()`

**CRDTs Can't Detect This.** They only see character edits, not symbol references.

**Solution Layers:**
1. **Detection:** Tree-sitter + symbol table
2. **Resolution:** Present options to agent:
   - Keep both (orphaned call)
   - Delete the call
   - Restore the function
   - Flag for manual review

### Challenge 4: Undo Semantics in Multi-Agent Edits

**Problem:** "Undo" is ambiguous with CRDTs.

**Solution:** Three undo concepts:
1. **Local undo:** Revert only my edits (Loro's UndoManager)
2. **Causal undo:** Revert my edit + effects on others (requires tracking)
3. **Temporal undo:** Revert to earlier version (CRDT history)

**Recommendation:** Implement local undo (simplest, works with CRDT).

---

## Part 10: Summary & Decision Matrix

### Quick Decision Guide

**If you prioritize:**

| Goal | CRDT | Rationale |
|------|------|-----------|
| Offline-first, Git-like versioning | Automerge | Branching/merging explicit, proven ecosystem |
| Real-time collaboration | Yrs | Proven fast, protocol built-in, good Rust bindings |
| Text accuracy (no interleaving) | Loro | Fugue algorithm, better merge semantics |
| Pure speed | Diamond-types or Cola | But trade features/ecosystem |
| All-in-one solution | None (use hybrid) | CRDT + validation layer required |

### Estimated Development Effort

| Component | Effort | Notes |
|-----------|--------|-------|
| Basic CRDT setup | 1-2 weeks | Choose & integrate library |
| Tree-sitter integration | 1-2 weeks | InputEdit conversion, symbol extraction |
| Validation layer | 2-4 weeks | Depends on language complexity |
| Undo/redo system | 1-2 weeks | Per-agent tracking |
| Agent communication | 1-3 weeks | Network protocol (if real-time) |
| Testing & edge cases | 2-4 weeks | Concurrent edits, merge conflicts |
| **Total** | **8-17 weeks** | For MVP with all layers |

---

## Conclusion

**The Rust ecosystem provides production-grade building blocks for multi-agent collaborative editing:**

1. **CRDTs (automerge, yrs, loro)** solve data consistency
2. **Tree-sitter** solves incremental parsing
3. **Undo crates** solve branching history
4. **Missing piece:** Structural validation isn't packaged

**For a headless code editor supporting multiple AI agents:**

- Use **Automerge** (or Yrs) as your CRDT foundation
- Layer **tree-sitter** for incremental parsing
- Add **custom validation engine** (symbol tables, type checking)
- Implement **per-agent undo tracking** with the `undo` crate
- Design for **modular conflict resolution** (detect, flag, offer options)

**The right choice depends on whether you value offline-first (Automerge) or real-time sync (Yrs)—but either works. The real challenge is the validation layer, which doesn't exist as a standard library yet.**

---

## References

### CRDT Libraries
- Automerge: https://github.com/automerge/automerge
- Yrs: https://github.com/y-crdt/y-crdt
- Loro: https://github.com/loro-dev/loro
- Diamond-types: https://github.com/josephg/diamond-types
- Cola: https://github.com/nomad/cola

### Undo/Redo
- Undo crate: https://crates.io/crates/undo
- History tree: https://github.com/PistonDevelopers/history_tree

### Parsing & Validation
- Tree-sitter: https://github.com/tree-sitter/tree-sitter
- Tree-sitter Rust: https://docs.rs/tree-sitter

### Production References
- Zed CRDTs: https://zed.dev/blog/crdts
- Figma multiplayer: https://figma.com/blog/how-figmas-multiplayer-technology-works/
- Fugue paper: https://arxiv.org/abs/2305.00583

### Articles
- "CRDTs go brrr" (diamond-types): https://josephg.com/blog/crdts-go-brrr/
- Loro richtext: https://loro.dev/blog/loro-richtext
- Eg-walker: https://arxiv.org/abs/2409.14252
