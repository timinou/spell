# Rust Ecosystem for AST-Aware Structural Editing Research

## Executive Summary

**Question**: Can Rust fully replace Emacs + combobulate for structural code editing?

**Answer**: **Partially.** Rust has solid foundational tools for AST search and pattern-based replacement, but lacks combobulate's full suite of context-aware structural operations (splice, drag, clone, transpose) out of the box. Gap analysis below.

---

## Current Spell Implementation

### Existing AST Infrastructure

**File**: `crates/pi-natives/src/ast.rs`
**Technology**: `ast-grep-core` (0.39+) + `tree-sitter` (0.25+)

**Capabilities Currently Used**:
- Pattern matching on AST nodes via `Pattern::try_new()` and `Pattern::contextual()`
- **Search**: `find_all()` to locate matching nodes across files
- **Replace**: `matched.replace_by(rewrite)` to emit `Edit<String>` with byte positions
- Batch application of edits via `apply_edits()` with overlap detection
- Multi-language support (~40 tree-sitter grammars via Cargo.toml)

**What It Does NOT Do**:
- Structural operations on living trees (e.g., modify a subtree, then re-serialize)
- Indentation-aware wrapping/unwrapping
- Safe sibling swapping or node duplication without text-level manipulation
- Incremental tree updates after mutations

---

## Rust Ecosystem Capabilities

### 1. Core Tree-Sitter Integration

| Crate | Version | Role | Limitation |
|-------|---------|------|-----------|
| `tree-sitter` | 0.25+ | Parsing + traversal API | Read-only; no edit API for mutations |
| `tree-sitter-<lang>` | Various | Language grammars | 40+ languages available |

**Incremental Parsing Support**: ✅ **YES**
- `tree-sitter` has `InputEdit` type for incremental re-parsing after mutations
- Docs state: "update previous syntax tree in <1ms" with `InputEdit`
- **BUT**: Spell's current ast-grep-core layer doesn't use this; it does text-level edits + full re-parse

---

### 2. AST-Grep-Core (Already Integrated)

**Crate**: `ast-grep-core` (0.39+)

**What It Provides**:
- jQuery-like traversal: `children()`, `parent()`, `next()`, `prev()`, `ancestors()`
- Pattern matching: `find(pattern)`, `findAll(pattern)`
- **Replacement**: `replace_by(rewrite: &str)` → `Edit<String>` struct
- Multi-language via tree-sitter backend
- Strictness modes (Smart, Cst, Ast) for matching

**What It LACKS**:
- ❌ **Splice**: No "unwrap node, keep children" operation
- ❌ **Drag**: No "swap siblings" operation
- ❌ **Clone**: No "duplicate subtree" operation
- ❌ **Transpose**: No "exchange adjacent nodes" operation
- ❌ **Envelope/Wrap**: No "wrap selection in new node" operation

**Current Use in Spell**: Pattern-based text replacement only. The AST is queried for the matched node's position, then the entire match is replaced as a string. No living-tree manipulation.

---

### 3. Tree-Sitter-Edit (Lightweight, Not Integrated)

**Crate**: `tree-sitter-edit` (0.4.0)
**Purpose**: Print modified tree-sitter parse trees for refactoring tools

**API Surface**:
```rust
pub trait Editor {
    // Mutate a tree, then serialize back to source
}
// Implementations: Delete, Id (no-op), LeftBiasedOr, Replace
```

**What It Provides**:
- Editor trait: compose mutations on a parse tree
- Implementations for delete and replace operations
- Designed for codemod workflows

**What It LACKS**:
- ❌ No higher-level ops (splice, drag, clone, transpose)
- ❌ No indentation inference or preservation
- ❌ Limited to delete + replace; no structural operations
- ❌ Not widely used; small community (~5 stars on GitHub)

**Assessment**: Promising for output generation but doesn't solve the structural editing gap.

---

### 4. Ropey (Text Buffer, Not AST)

**Crate**: `ropey` (2.0 beta)
**Purpose**: Efficient UTF-8 text rope for editors

**What It Provides**:
- O(M + log N) insertions/deletions where N = total length, M = edit length
- Line-aware indexing and iteration
- Thread-safe cloning (CoW)
- Handles large texts (GB+) efficiently

**What It LACKS**:
- ❌ **No AST awareness at all** — operates on raw text
- ❌ Complementary to AST tools, not a replacement
- ❌ Useful as a backing buffer but not for structural editing

**Conclusion**: Would be good for **text buffer** in a Rust-based editor, but doesn't address AST operations.

---

### 5. Syn Crate (Rust-Specific)

**Crate**: `syn` (latest)
**Purpose**: Parse Rust syntax into a Rust-specific AST

**What It Provides**:
- Full Rust syntax AST (expressions, items, types)
- Visitor pattern: `Visit`, `VisitMut`, `Fold` traits for tree traversal
- Visitor method stubs for each AST node type
- Useful for derive macros and Rust-specific codegen

**What It LACKS**:
- ❌ **Rust-only** — no support for other languages
- ❌ Doesn't address structural editing operations
- ❌ Visitor pattern is for *traversal*, not *transformation* per se
- ❌ No built-in "splice node" or "drag sibling" helpers

**Assessment**: Excellent for Rust metaprogramming, irrelevant for multi-language structural editing.

---

## Combobulate Operations vs. Rust Ecosystem

### Combobulate's Core Operations

| Operation | Purpose | Emacs Implementation |
|-----------|---------|----------------------|
| **Splice** | Unwrap node; promote children to parent level | `combobulate-splice` — deletes parent bounds, keeps text |
| **Drag** | Swap current node with previous/next sibling | `combobulate-drag-up`/`down` — uses `transpose-subr-1` |
| **Clone** | Duplicate a subtree with DWIM node selection | `combobulate-clone-node-dwim` — copies region, inserts, indents |
| **Transpose** | Exchange two adjacent sexps | `combobulate-transpose-sexps` — calls `transpose-subr-1` |
| **Envelope** | Wrap selection in new syntactic construct | `combobulate-envelope-*` — interactive prompt, inserts boundaries |

### Rust Ecosystem Equivalents

| Operation | Rust Approach | Gap |
|-----------|---------------|-----|
| **Splice** | Manual: find node range, delete parent delimiters, apply edits | **Large**: Requires language-specific knowledge; no generic impl |
| **Drag** | Manual: find siblings, capture text, swap via edits | **Large**: No tree-aware sibling operation; must handle whitespace |
| **Clone** | Manual: copy node text range, re-indent, insert | **Large**: No indentation inference; lossy if whitespace mattersmatters |
| **Transpose** | Manual: find adjacent nodes, capture, swap text | **Large**: Text-level swap loses structural properties |
| **Envelope** | ast-grep Replace can do simple wraps; no interactive selection | **Large**: No interactive node selection; limited to patterns |

---

## Honest Gap Assessment

### What Rust CAN Do Well
1. **Language-agnostic parsing**: tree-sitter covers 40+ languages
2. **Pattern-based search**: ast-grep handles complex AST queries
3. **Text-level replacement**: ast-grep's `replace_by` works reliably
4. **Incremental parsing**: tree-sitter's API supports it (unused by Spell)
5. **Multi-file refactoring**: ast-grep scales to large codebases

### What Rust CANNOT Do (Without Custom Implementation)
1. **Context-aware node selection**: No "select the expression at point" that understands grammar nuances
2. **Structural splice**: No generic "unwrap this layer" that preserves children
3. **Drag with indentation preservation**: No automatic indent inference
4. **Interactive preview + commit**: No REPL-like refactor environment
5. **Language-specific rules**: No built-in knowledge of "what's a statement vs. expression" per language

### Why the Gap Exists
- Combobulate works **at the Emacs buffer level** with **real cursors, regions, and editing contexts**
- Rust crates work **on serialized ASTs** with **no awareness of indentation, formatting, or user intent**
- Combobulate's strengths (interactive, language-aware fallbacks, visual feedback) don't map to Rust's static analysis tooling model

---

## Proof of Concept: Can Rust Do Splice?

**Minimal splice** (proof-of-concept):

```rust
// 1. Parse tree
let ast = language.ast_grep(source);
let node = ast.root().find(pattern)?;

// 2. Get node bounds + parent bounds
let (node_start, node_end) = node.range();
let parent = node.parent()?;
let (parent_start, parent_end) = parent.range();

// 3. Collect children inside node
let children_text: Vec<String> = node
    .children()
    .map(|child| source[child.range()].to_string())
    .collect();

// 4. Build edit: replace entire parent with just the children
let replacement = children_text.join("");
let edit = Edit {
    position: parent_start,
    deleted_length: parent_end - parent_start,
    inserted_text: replacement.into_bytes(),
};

apply_edits(source, &[edit])?
```

**Problems with this approach**:
- ❌ No indentation adjustment — children inherit parent's indent
- ❌ No whitespace handling — what if children had different indents?
- ❌ Language-specific — what counts as "children"? (fields? elements? statements?)
- ❌ No validation — does the result parse?
- ❌ No interactive feedback — user doesn't preview before commit

**Conclusion**: Technically possible but error-prone and incomplete.

---

## Recommendations

### For Spell's Current Use Case (Multi-Language Refactoring)

**Status**: ✅ **ast-grep-core is sufficient for search + replace workflows**
- Pattern-based rewriting is robust
- Multi-language support is strong
- No need to add splice/drag/clone unless users explicitly request them

### If Splice/Drag/Clone Becomes a Requirement

**Option 1: Implement Selectively (Recommended)**
- Add splice for 3-5 languages with clear syntax rules (Python, JavaScript, Rust, Go, Java)
- Use language-specific helper functions to infer indentation
- Provide a `--preview` flag so users see the result before commit
- Cost: ~500-1000 LOC per language

**Option 2: Stay with Emacs (Current Approach)**
- Combobulate is mature, tested, and handles all these ops
- Rust tooling is better for batch refactoring (many files at once)
- Split the tool: Emacs for interactive editing, Rust for large-scale codemods
- Cost: Maintenance of two separate code paths (already the case)

**Option 3: Hybrid Integration**
- Keep ast-grep-core for search/replace (batch operations)
- Call out to Emacs/Combobulate for interactive splice/drag/clone
- Use Spell's existing Emacs daemon to execute combobulate commands via RPC
- Cost: Low (plumbing only); reuses existing infrastructure

### If True Replacement Is Needed (Not Recommended)

To replace Combobulate entirely in Rust would require:
1. **Language definitions**: Hardcode splice/drag/clone rules for each grammar
2. **Indentation engine**: Infer indent from file + language rules
3. **Node selection UX**: REPL or language server protocol
4. **Formatting**: Re-serialize with correct spacing (hard for tree-sitter)
5. **Testing**: Validate output parses + semantics preserved

**Estimated effort**: 5-10k LOC + 2-3 months for 5 languages. **Not worth it for most use cases.**

---

## Conclusion

### Direct Answer to the Research Question

**Can Rust fully replace Emacs + combobulate for structural code editing?**

**NO — but not because of Rust. Because of the problem domain.**

Combobulate's power comes from:
1. Living in the Emacs buffer (aware of point, regions, undo)
2. Interactive feedback (see the change before committing)
3. Language-specific fallbacks (when grammar is ambiguous)
4. Tight binding to editor state (indentation, folding, etc.)

Rust's strengths are:
1. Fast, parallelizable AST operations
2. Multi-language pattern matching
3. Batch refactoring at scale

**The tools solve different problems.** ast-grep-core is best for:
- "Find and replace all instances of pattern X across 1000 files"

Combobulate is best for:
- "I'm at this node; splice it up, let me preview, adjust cursor position"

### Recommendation for Spell

**Current state is optimal**: Use Rust for large-scale transformations, Emacs for interactive editing. The hybrid approach is already in place.

If structural editing becomes a priority, **Option 3 (Hybrid Integration)** is the best ROI — call Combobulate from Spell's Rust orchestration layer for interactive ops.

---

## Appendix: Rust Crate Comparison Table

| Crate | Type | Lang Coverage | Splice | Drag | Clone | Transpose | Indentation | Interactive |
|-------|------|----------------|--------|------|-------|-----------|-------------|-------------|
| ast-grep-core | AST Search/Replace | 40+ via tree-sitter | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| tree-sitter | Parsing | 40+ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| tree-sitter-edit | AST Output | 40+ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ropey | Text Buffer | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| syn | Rust AST | Rust only | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Combobulate (Emacs) | Structural Edit | 10+ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Legend**: "Lang Coverage" = number of languages supported; ops = operation support; "Indentation" = automatic indent preservation; "Interactive" = user preview before commit.

