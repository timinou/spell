# Combobulate DSL & Manipulation System Deep Dive

## Executive Summary

Combobulate is a declarative tree-sitter manipulation framework built on Emacs Lisp. It provides:
1. **Procedure DSL**: A declarative rule system for finding nodes in the syntax tree
2. **Manipulation Operations**: Splice, drag, clone, transpose
3. **Refactoring Framework**: Overlay-based transaction system with rollback capability
4. **Interactive Proffer System**: Multi-choice selection with real-time preview

This analysis covers what a Rust implementation would require for headless agent use.

---

## Part I: Procedure DSL System

### Architecture Overview

The procedure system operates in two phases:

```
Input (point-or-node)
    ↓
Phase 1: ACTIVATION (find candidate nodes matching pattern)
    ↓
Phase 2: SELECTION (filter activated nodes using matchers)
    ↓
Output (list of matched nodes)
```

### Phase 1: Activation Nodes

Activation nodes are the initial filter - they answer: "What nodes do we want to operate on?"

**Location**: `combobulate-procedure.el` lines 71-124

**Structure**:
```elisp
(:activation-nodes
  ((:nodes RULES
    :position POSITION-RULE     ; optional
    :has-parent HAS-PARENT-RULE ; optional (mutually exclusive with :has-ancestor)
    :has-ancestor HAS-ANCESTOR-RULE ; optional
    :has-fields FIELDS-RULE)    ; optional
   ...))
```

**:nodes Rules** (line 85-90):
- **Strings**: Direct node type matching (e.g., `"comment"`, `"property_name"`)
- **`(rule TYPE [FIELD ...])`**: Production rule expansion
  - `(rule "expression")` → expands to all child types in expression rule
  - `(rule "pattern" :all)` → expand all fields in pattern rule
  - Handles supertypes (abstract node types not in actual parse tree)
- **`(rule-rx REGEXP)`**: Regex match against all node types
- **`(rx ...)`**: Direct regex patterns
- **`(irule TYPE)`**: Inverted production rule (find parents of TYPE)
- **`(all)` or `t`**: Match all node types
- **`(exclude INCLUSIONS EXCLUSIONS)`**: Set difference

**:position Rules** (line 91-106):
- `'any'` (default): Point can be anywhere in node
- `'at'`: Point must be at exact beginning of node
- `'in'`: Point inside node but NOT at beginning

**:has-parent / :has-ancestor** (line 112-120):
- `:has-parent`: Immediate parent must match rules
- `:has-ancestor`: Any ancestor must match rules
- Returns matched parent node for use in selector
- Mutually exclusive

**:has-fields** (line 107):
- Node must belong to specified field name in parent node
- Field names come from tree-sitter grammar (e.g., `body`, `arguments`, `condition`)

**Example from Python**:
```elisp
(:activation-nodes
  ((:nodes ("string_content" "interpolation")
    :has-parent ("string"))
   (:nodes ((rule "parameter"))
    :has-parent ("parameters" "lambda_parameters" "argument_list"))
   (:nodes ((all))
    :has-parent ((all)))))
```

### Phase 2: Selector (Optional Filtering)

After activation, optionally refine results using selectors.

**Location**: `combobulate-procedure.el` lines 519-546

**Structure**:
```elisp
:selector
(:choose CHOICE-TARGET
 <MATCHER-PROPERTY>)
```

**:choose** (lines 522-529):
- `'node'`: Operate on the activated node itself
- `'parent'` (default): Operate on the matched parent from :has-parent/:has-ancestor

**Matcher Properties** (one required):

#### Option A: `:match-children` (line 542)
```elisp
:match-children
  (:match-rules (rule-list)      ; nodes to match
   :discard-rules (rule-list)    ; nodes to exclude
   :default-mark @match          ; nodes matching neither
   :anonymous t/nil)             ; include anonymous nodes
```
- Finds direct children of chosen node
- Marks with `@match`, `@discard`, or default
- Implementation: `combobulate-node-children`

#### Option B: `:match-siblings` (line 541)
```elisp
:match-siblings
  (:match-rules (rule-list)
   :discard-rules (rule-list)
   :default-mark @match
   :anonymous t/nil)
```
- Finds all siblings of chosen node (not children)
- Implementation: `combobulate-linear-siblings`

#### Option C: `:match-query` (line 535)
```elisp
:match-query
  (:query QUERY-FORM
   :engine 'combobulate|'treesitter  ; default: combobulate
   :discard-rules (rule-list))
```
- Uses tree-sitter capture query or Combobulate's query language
- Non-recursive vs recursive matching based on engine
- Query results tagged with `@match`, `@discard`

**Example from Python (sibling filtering)**:
```elisp
:selector (:match-children
           (:discard-rules ("string_start" "string_end")
            :default-mark @match))
```

### Phase 3: Result Filtering

**Location**: `combobulate-procedure.el` lines 549-555

After selector filtering, nodes tagged with `@match` are extracted:

```elisp
(combobulate-procedure--filter-marked-nodes selected-nodes t nil)
```

Only nodes with `@match` marker are returned in `matched-nodes` field.

### Data Structure: `combobulate-procedure-result`

**Location**: `combobulate-procedure.el` lines 59-69

```elisp
(cl-defstruct combobulate-procedure-result
  activation-node       ; which activation rule matched
  action-node           ; node at point when procedure started
  parent-node           ; parent node from :has-parent/:has-ancestor
  selected-nodes        ; raw selector output (with marks)
  matched-nodes         ; @match nodes only
  (matched-activation nil) ; t if any activation rule matched
  (matched-selection nil)) ; t if selector matched (or 'n/a' if no selector)
```

### Real-World Examples

**Python Expression Matching**:
```elisp
'((expressions . ((:activation-nodes
                   ((:nodes ((rule "expression") (rule "primary_expression")))))))
```
Expands `(rule "expression")` to all nodes that are children of the expression production rule.

**Python Sibling Navigation**:
```elisp
(:activation-nodes
  ((:nodes ("string_content" "interpolation")
    :has-parent ("string"))
 :selector (:match-children
            (:discard-rules ("string_start" "string_end")
             :default-mark @match)))
```
1. Activate on string_content/interpolation inside string
2. Match all children of current node, except delimiters

**Python Hierarchy Descent**:
```elisp
(:activation-nodes
  ((:nodes ((rule "_compound_statement") "case_clause")
    :position at)
 :selector (:choose node
            :match-children (:match-rules ("block")))))
```
1. Activate on compound statements at position
2. Select only block children
3. Allows descending into block bodies

---

## Part II: Manipulation Operations

### 1. SPLICE

**Purpose**: Remove a node, optionally keeping selected parts of it.

**User Commands** (`combobulate-manipulation.el` lines 1161-1177):
- `combobulate-splice-up`: Keep `(self after around)`
- `combobulate-splice-self`: Keep `(self)`
- `combobulate-splice-down`: Keep `(self before around)`
- `combobulate-splice-parent`: Keep `(before after around self)`

**Core Implementation** (`combobulate-manipulation.el` lines 1181-1381):

#### Algorithm (simplified):

1. **Find splicing candidates** (lines 1219-1253)
   - Apply procedure to get sibling nodes
   - If no procedure matches, do ad-hoc search through all nodes at point
   - Result: `procedure-result` with matched sibling nodes

2. **Partition nodes by position** (lines 1267, `combobulate--partition-by-position` line 1145)
   ```elisp
   (combobulate--partition-by-position self-node query-nodes)
   ```
   Groups nodes as: `(before . node)`, `(self . node)`, `(after . node)`, `(around . node)`
   - `before`: Nodes before self-node
   - `self`: The node itself
   - `after`: Nodes after self-node
   - `around`: Nodes that contain self-node (larger)

3. **Filter by partition type** (lines 1262-1276)
   ```elisp
   (seq-keep (lambda ((partition . node))
               (and (member partition partitions) node))
             partitions-list)
   ```
   Keeps only nodes matching requested partitions.

4. **Get range extent** (lines 1279-1283)
   ```elisp
   (combobulate-node-range-extent matches)
   ```
   Gets min/max boundaries of all kept nodes.

5. **Validate splice targets** (lines 1289-1300)
   - Filters parent candidates
   - Checks: parent contains node type, parent in correct position
   - Used to offer user choices

6. **Interactive selection** (lines 1301-1368)
   Uses `combobulate-proffer-choices` to let user select which parent to splice to.
   - Real-time preview: shows error nodes if syntax invalid
   - Displays tallied nodes: "Keep 2 expressions. Discard 1 block."

7. **Refactor execution** (lines 1304-1357)
   ```elisp
   (combobulate-refactor (:id refactor-id)
     (mark-node-deleted current-node)
     (mark-range-highlighted start end)
     (commit))  ; applies deletion
   ```
   - Marks target node for deletion
   - Uses envelope system to insert kept nodes
   - Handles indentation (first line adjusted to current column)
   - Handles spacing (removes/adds single space as needed)
   - Indents resulting region

#### Indentation Handling (lines 1286-1288, 1340-1357)
```elisp
(combobulate-indent-string-first-line text col)
(delete-horizontal-space)
(just-one-space)
(apply (combobulate-read envelope-indent-region-function) ...)
```
- Adjusts first line to match current column
- Deletes/adds spaces before/after spliced content
- Reindents entire affected region per language-specific rules

#### Error Handling (lines 1323-1331)
- Detects ERROR nodes in tree after deletion
- Shows error indicator to user: "Invalid"
- Allows user to pick different parent

### 2. CLONE (Copy & Insert)

**User Command** (`combobulate-manipulation.el` lines 1001-1022):
- `combobulate-clone-node-dwim`: Clone node at point N times

#### Algorithm:

1. **Get navigable nodes at point** (lines 1006-1008)
   ```elisp
   (seq-sort #'combobulate-node-larger-than-node-p
             (combobulate--get-all-navigable-nodes-at-point))
   ```
   Sorts by size (largest first).

2. **Interactive selection** (lines 1006-1020)
   Uses proffer to let user select which node to clone.
   - Highlights current choice
   - Shows how it will look after cloning
   - Preserves overlay positions as node shifts

3. **Clone execution** (lines 1017, 1022)
   ```elisp
   (combobulate--clone-node node (combobulate-node-start node))
   ```

**Core Clone Implementation** (`combobulate-manipulation.el` lines 505-597):

#### `combobulate--clone-node` (lines 505-507)
```elisp
(defun combobulate--clone-node (node position)
  (combobulate--place-node-or-text position node))
```
Wraps placement logic; delegates to `combobulate--place-node-or-text`.

#### `combobulate--place-node-or-text` (lines 509-597)

**Input**: `position node-or-text &optional mode no-trailing-newline`

**Modes**:
- `'newline'` (default): Place on new line with split-line
- `'inline'`: Place inline with other content

**Algorithm**:

1. **Calculate column** (lines 528-529)
   ```elisp
   (current-column)  ; at target position
   ```

2. **Handle node text** (lines 534-578)
   - If STRING: Indent text to match current column
   - If NODE: 
     - Extract indentation of original node
     - Calculate relative offset to target position
     - Handle sequence separators (commas, semicolons)
       ```elisp
       (when-let ((node-after (combobulate-node-on (point) (1+ (point)))))
         (if (named-p node-after) "" (node-text node-after)))
       ```

3. **Newline vs inline insertion** (lines 586-597)
   - If newline: `split-line 0` then insert with refactor system
   - If inline: Insert, handle spacing with `just-one-space`

4. **Sequence separator handling** (lines 542-564)
   - Detects separator (comma, semicolon, etc.) after node
   - Appends to cloned text if anonymous
   - Omits if named node or no separator found

#### Indentation system (`combobulate-indent-string`)
```elisp
(combobulate-indent-string node-text
  :first-line-amount col
  :first-line-operation 'absolute|'add|'relative
  :rest-lines-amount relative-amount)
```
- Adjusts first line absolutely or relatively
- Applies additional indentation to rest of lines
- Used to preserve structure when cloning into different context

### 3. TRANSPOSE (Swap Adjacent Nodes)

**User Command** (`combobulate-manipulation.el` lines 265-283):
- `combobulate-transpose-sexps`: Swap sexp-like nodes around point

#### Algorithm (lines 273-283):

1. **Find backward node** (line 273)
   ```elisp
   (combobulate-transpose-sexps-1 t)  ; backward=t
   ```

2. **Find forward node** (line 274)
   ```elisp
   (combobulate-transpose-sexps-1 nil)  ; backward=nil
   ```

3. **If both found**: Swap regions (line 278)
   ```elisp
   (combobulate--swap-node-regions backward-node forward-node)
   ```
   Uses `transpose-subr-1` on node ranges.

4. **Fallback**: Use Emacs `transpose-sexps` if combobulate fails

**Helper**: `combobulate-transpose-sexps-1` (lines 257-263)
```elisp
(defun combobulate-transpose-sexps-1 (backward)
  (with-navigation-nodes (:procedures (combobulate-read procedures-sexp)
                         :backward backward :skip-prefix t)
    (combobulate-forward-sexp-function-1 backward)))
```
- Uses navigation procedures to find valid sexp
- Respects language-specific sexp rules

### 4. DRAG (Move Node Up/Down)

**User Commands** (`combobulate-manipulation.el` lines 1672-1682):
- `combobulate-drag-up`: Swap with previous sibling
- `combobulate-drag-down`: Swap with next sibling

**Core Implementation** (`combobulate-manipulation.el` lines 1453-1467):

```elisp
(defun combobulate--drag (direction)
  (let* ((up (eq direction 'up))
         (node (combobulate--get-nearest-navigable-node))
         (sibling (combobulate--get-sibling node (if up 'backward 'forward)))
         (self (combobulate--get-sibling node 'self)))
    (unless sibling (error "No sibling node to swap with"))
    (combobulate--goto-node sibling)
    (save-excursion (combobulate--swap-node-regions self sibling))
    (combobulate--get-sibling (combobulate--get-nearest-navigable-node) 'self)))
```

**Steps**:
1. Get nearest navigable node (current position)
2. Get sibling in direction (backward for up, forward for down)
3. Get self reference (the node itself)
4. Move point to sibling
5. Swap regions of self and sibling
6. Return the navigated node for follow-up operations

**Swap Implementation**: `combobulate--swap-node-regions` (lines 253-255)
```elisp
(transpose-subr-1 (combobulate-node-range node-a)
                  (combobulate-node-range node-b))
```
Uses Emacs' built-in `transpose-subr-1` for efficient buffer manipulation.

---

## Part III: Refactoring Framework

### Refactor Macro: `combobulate-refactor`

**Location**: `combobulate-manipulation.el` lines 149-222

**Purpose**: Provides transaction-like semantics with automatic rollback.

**Signature**:
```elisp
(combobulate-refactor (:id session-id) &rest body)
```

**Session Management**:
```elisp
combobulate-refactor--active-sessions  ; alist of (id . overlays)
```
- Each session has unique ID
- Tracks all overlays (pending operations)
- Can nest sessions (pre-existing sessions preserved)

**Available Operations** (inside macro):

```elisp
(mark-range-move beg end position)        ; Move text
(mark-range-deleted beg end)              ; Delete text
(mark-range-highlighted beg end face)     ; Show what will change
(mark-node-deleted n)                     ; Delete node
(mark-node-highlighted n face)            ; Highlight node
(mark-node-copy n)                        ; Copy node for later insertion
(mark-range-indent beg end pt column)     ; Re-indent region
(mark-cursor pt)                          ; Set cursor position
(commit)                                  ; Execute all operations
(rollback)                                ; Undo all operations
```

**How it Works**:

1. **Marking Phase**: Operations don't modify buffer
   - Create overlays at text ranges
   - Store action in overlay property: `combobulate-refactor-actions`
   - Can preview changes before committing

2. **Commit Phase**: Execute all overlays (lines 201-212)
   ```elisp
   (mapc (lambda (ov) (combobulate--refactor-commit ov t))
         (seq-sort (lambda (a b) (> (overlay-start a) (overlay-end b)))
                   overlays))
   ```
   - Processes overlays in reverse order (highest position first)
   - Prevents position shifts from breaking later edits

3. **Refactor Commit** (`combobulate-manipulation.el` lines 1494-1544)
   ```elisp
   (defun combobulate--refactor-commit (ov &optional destroy-overlay)
     (pcase action
       (`(copy-region ,target-var)      ...)
       (`(move ,beg ,end ,position)     ...)
       ('(delete-region)                ...)
       (`(indent ,pt ,baseline-column)  ...)
       ('(set-point)                    ...)
       ...))
   ```

**Action Types**:

| Action | Effect |
|--------|--------|
| `(copy-region var)` | Store region text in variable |
| `(move beg end pos)` | Cut region, paste at position |
| `(delete-region)` | Delete region |
| `(indent pt col)` | Reindent region to column |
| `(set-point)` | Set cursor position |
| `(highlighted)` | Just visual (no effect) |
| `(field tag text)` | Interactive field (snippet-like) |

### Proffer System: `combobulate-proffer-choices`

**Location**: `combobulate-manipulation.el` lines 710-999

**Purpose**: Multi-choice UI with live preview of transformations.

**Usage**:
```elisp
(combobulate-proffer-choices nodes
  (lambda (action)
    (combobulate-refactor (:id refactor-id)
      (action-fn action)
      (commit)))
  :prompt-description "Splice out"
  :reset-point-on-abort t
  :quiet nil)
```

**Key Features**:

1. **Automatic Selection**: Single choice auto-selects (line 900)
2. **Cycling**: TAB / S-TAB cycles through choices (lines 942-971)
3. **Numeric Selection**: C-1 through C-9 for graphical displays (lines 837-839)
4. **Status Display** (lines 866-888):
   - Display indicator: "1/3"
   - Current node pretty-printed
   - Key bindings shown
   - Optional tree view of node
5. **Rollback Behavior** (lines 779-781):
   - Accept action: `rollback` (discard preview)
   - Switch action: `rollback` (discard prev preview)
   - Cancel action: `rollback` (discard preview)
   - Accept then commits final changes

**Change Group Integration**:
```elisp
(prepare-change-group)  ; Start undoable group
(activate-change-group) ; Commit all changes
(cancel-change-group)   ; Undo all changes
```

---

## Part IV: Emacs Buffer Integration

### Buffer State Dependencies

**1. Current Point Position**
- All procedures start from `(point)`
- Relative position determines activation `:position` matching

**2. Buffer Text & Indentation**
- Splice/clone operations read actual text, preserve indentation
- Must track line-beginning-position for indent calculations
- Column-based positioning (visual/graphical layout)

**3. Tree-Sitter Parser**
- Automatic on every buffer change
- Trees cached per buffer
- Error nodes indicate syntax violations

**4. Undo System**
- Uses `with-undo-amalgamate` for atomic operations
- Change groups for rollback

### Headless Compatibility Issues

**Emacs-Specific**:
- `(point)` → needs explicit position argument
- `(current-indentation)` → needs column tracking
- `(looking-at)` → needs manual string search
- `delete-region`, `insert` → direct buffer ops unavailable
- Overlays → needs custom tracking system
- Interactive prompt (`read-key`) → needs API calls

---

## Part V: Language-Specific Rules

### Grammar-Based Matching

**Production Rules**: Maps node types to their children
```elisp
(combobulate-production-rules-get "expression")
 → ("name" "number" "string" "call" "binary_op" ...)
```

Used by:
- `(rule "expression")` expansion
- `(irule "identifier")` inverse lookup
- Sibling/child relationship validation

### Discard Rules

**Global discards** (per language):
```elisp
procedure-discard-rules  ; Usually: '(comment)
```
Line comments break tree-sitter. Automatically filtered unless explicitly requested.

**Selective discard** in matchers:
```elisp
:discard-rules ("string_start" "string_end")
```

### Language-Specific Indent

**Indent function** (read from settings):
```elisp
(combobulate-read indent-calculate-function)
```
Pluggable per language:
- Python: `#'combobulate-python-calculate-indent`
- JavaScript: default Emacs indent
- etc.

**Indent region function** (read from settings):
```elisp
(combobulate-read envelope-indent-region-function)
```
- Python: Uses `python-indent-shift-right` / `left`
- Default: `indent-rigidly`

### Plausible Separators

**Guessed from grammar** (line 562):
```elisp
(combobulate-read plausible-separators)
 → '("," ";" ":" "=" ...)
```
Used to detect sequence separators when cloning.

---

## Part VI: Rust Implementation Strategy

### What's Replicable in Rust

✅ **Pure tree-sitter operations** (readily portable):
1. Node querying and traversal
2. Production rule matching
3. Procedure DSL evaluation
4. Splice partitioning algorithm
5. Clone text extraction and indentation

✅ **Core manipulation algorithms**:
1. Range-based node merging/deletion
2. Transpose via range swapping
3. Drag via sibling lookup and swap

### What Requires Architecture Changes

⚠️ **Interactive/Buffer-dependent operations**:

| Operation | Issue | Rust Solution |
|-----------|-------|----------------|
| Point-based activation | Points change as buffer edits | Use text ranges instead, track delta |
| Proffer UI/Prompt | Emacs interactive loop | JSON RPC request → wait for selection |
| Column-based indent | Visual column layout | Use tab width, track byte offsets |
| Undo/Change groups | Emacs undo state | Git-like staging area per operation |
| Overlays as tracking | Overlays shift with edits | Track ranges as (start, end) with offsets |

### Minimum Viable Headless Implementation

For headless agent use (no interactive UI):

```
Input: (source_code, range_start, range_end, operation, operation_args)
│
├─ Parse with tree-sitter
├─ Locate nodes in range
├─ Apply procedure DSL (deterministic selection, no choices)
├─ Execute manipulation:
│  ├─ Collect affected ranges
│  ├─ Build edits in reverse order
│  └─ Apply edits (highest position first)
└─ Output: (modified_source_code, new_range)
```

**Key differences**:
1. **No point**: Use absolute text ranges
2. **No proffer**: Use first matching procedure result
3. **No overlays**: Track as `(start, end, delta)` tuples
4. **No undo**: Build complete edit list, apply atomically
5. **No indent**: Require caller to reindent if needed (or call language indent server)

### Production Considerations

**Must handle**:
1. Error nodes (syntax violations) - return error, don't mutate
2. Range shifts during multi-edit sequences
3. Separator detection (clone) - needs grammar knowledge
4. Language-specific indent rules - delegate to language server

**Can drop**:
1. Interactive selection (deterministic choice)
2. Visual feedback (no overlays)
3. Real-time preview (not needed in batch mode)
4. Sequence nesting (each operation atomic)

---

## Part VII: Reference Implementation Examples

### Splice Algorithm (Pseudocode)

```rust
fn splice(
    tree: &Tree,
    node: &Node,
    partitions: &[SplicePartition],
) -> Result<TextEdit> {
    // 1. Activate procedure
    let procedure_result = apply_procedure(tree, node)?;
    let matched_nodes = procedure_result.matched_nodes;
    
    // 2. Partition by position
    let partitioned = partition_by_position(node, matched_nodes);
    
    // 3. Filter by partition type
    let kept = partitioned.iter()
        .filter(|(part, _)| partitions.contains(part))
        .collect::<Vec<_>>();
    
    if kept.is_empty() {
        return Err("Nothing to keep");
    }
    
    // 4. Get range extent
    let (start, end) = range_extent(&kept);
    
    // 5. Validate parents
    let legal_parents = find_legal_splice_parents(node)?;
    
    // 6. Apply edit (deterministic - no choice)
    let parent = legal_parents[0];
    
    let kept_text = source[start..end].to_string();
    let kept_text = adjust_indent(kept_text, current_column);
    
    Ok(TextEdit {
        delete: node.byte_range(),
        insert_at: node.start_byte(),
        text: kept_text,
    })
}
```

### Clone Algorithm (Pseudocode)

```rust
fn clone(
    tree: &Tree,
    node: &Node,
    source: &str,
) -> Result<TextEdit> {
    // 1. Get node text
    let node_text = &source[node.byte_range()];
    
    // 2. Extract separator if present
    let separator = if let Some(next) = node.next_sibling() {
        if is_anonymous(next) && is_plausible_separator(next.kind()) {
            source[next.byte_range()].to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    
    // 3. Adjust indentation
    let original_indent = get_node_indent(tree, node);
    let target_column = get_target_column(insertion_point);
    let delta = target_column - original_indent;
    
    let adjusted_text = apply_indent_delta(node_text, delta);
    
    Ok(TextEdit {
        insert_at: insertion_point,
        text: adjusted_text + separator,
    })
}
```

### Drag Algorithm (Pseudocode)

```rust
fn drag(
    tree: &Tree,
    node: &Node,
    direction: DragDirection,
    source: &str,
) -> Result<Vec<TextEdit>> {
    let sibling = match direction {
        Up => node.prev_sibling(),
        Down => node.next_sibling(),
    }?;
    
    // Swap via two edits (in reverse order)
    Ok(vec![
        TextEdit {
            delete: node.byte_range(),
            ..
        },
        TextEdit {
            delete: sibling.byte_range(),
            insert_at: node.start_byte(),
            text: source[sibling.byte_range()].to_string(),
        },
        TextEdit {
            insert_at: sibling.start_byte(),
            text: source[node.byte_range()].to_string(),
        },
    ])
}
```

---

## Part VIII: Critical Implementation Decisions

### 1. Procedure DSL Evaluation

**Decision**: Build as interpreter or compile to queries?

- **Interpreter (flexible)**: Evaluate each activation/selector at runtime
  - Pro: Easy to debug, dynamic rules
  - Con: Slower, more code
  - Use for: Initial MVP

- **Compiled to tree-sitter queries**: Pre-compile to S-expressions
  - Pro: Fast, leverages tree-sitter
  - Con: Limited expressiveness, complex compilation
  - Use for: Production optimization

### 2. Error Handling

**Splices with ERROR nodes**: Block operation or warn?
- Current Emacs: Shows "Invalid" indicator, lets user retry
- Headless Rust: Return error immediately, don't mutate

**Invalid node references**: Should splice fail or succeed with less?
- Decision: Fail fast, return descriptive error with what was expected

### 3. Indentation Strategy

**Full reindentation vs. local adjustment**?
- Splice/clone: Adjust first line, let indent server handle rest
- Drag: Keep original indentation (no change)
- Recommendation: Require caller to run format/indent after if needed

### 4. Separator Detection

**Always include separators?**
- Current: Guesses based on `plausible-separators` + anonymous node check
- Rust: Same heuristic, but requires grammar knowledge
- Fallback: Let caller specify separator explicitly

### 5. Partition Ordering

**When multiple splice targets valid, which first?**
- Current Emacs: Uses `seq-filter` → order is deterministic but implicit
- Rust: Return all valid targets, let caller choose, or pick lexically first

---

## Conclusion

Combobulate's manipulation operations are **90% tree-sitter-based** and **10% Emacs-integration**. 

A Rust port for headless agents would:
1. ✅ Keep all procedure DSL logic
2. ✅ Keep all manipulation algorithms
3. ⚠️ Replace interactive proffer with JSON RPC
4. ⚠️ Replace overlays with range tracking
5. ⚠️ Simplify indentation (delegate to language server)

**Estimated scope**: 
- Core operations (splice/clone/drag/transpose): ~2000 LOC
- Procedure DSL: ~1500 LOC
- Refactoring framework: ~1000 LOC
- Tests: ~3000 LOC
- **Total: ~7500 LOC Rust** (vs. ~1686 LOC Elisp, but Elisp is more concise)

The biggest challenge is **not** the algorithms—it's handling **text-range tracking through multi-edit sequences** without Emacs' overlay system.
