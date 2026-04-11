# Navigate Implementation Path: Full Architecture Analysis

**Objective:** Trace the complete path for navigate calls from `code.ts` through the Emacs client to Elisp, identifying failure modes and root causes.

---

## 1. Call Path: code.ts → client.ts → Elisp

### 1.1 Entry Point: code.ts Tool Dispatch

**File:** `packages/coding-agent/src/tools/code.ts` (lines 67-72)

```typescript
case "navigate": {
    const file = args.file as string;
    const action = args.action as string;
    const line = args.line as number | undefined;
    const column = args.column as number | undefined;
    return await client.navigate(file, action, line, column);
}
```

**Contract:**
- `file`: absolute or project-relative path
- `action`: one of `defun-at | parent | references-local | node-at | siblings | children`
- `line`: 1-indexed line number (optional, only required for some actions)
- `column`: 1-indexed column number (optional)

**Returns:** JSON-encoded result from Elisp

---

### 1.2 TypeScript Client: client.ts

**File:** `packages/emacs/src/client.ts` (lines 73-80)

```typescript
async navigate(file: string, action: string, line?: number, column?: number): Promise<unknown> {
    return callToolOnce(socat, socketPath, "code-navigate", {
        file,
        action,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
    });
}
```

**Responsibility:**
- Marshals TypeScript parameters into a JSON-RPC request
- Calls `callToolOnce()` which:
  1. Spawns socat subprocess connecting to Emacs MCP socket
  2. Sends JSON-RPC request: `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"code-navigate","arguments":{...}}}`
  3. Reads response with 30-second timeout
  4. Parses JSON-RPC response
  5. **Extracts first text content block** — failure point #1 occurs here

**Failure Mode #1: "no text content block"**
- **Trigger:** Elisp returns a response with no `"type": "text"` block in the `content` array
- **Line 198-200:** `const textBlock = parsed.result.content.find(c => c.type === "text");`
- **Root Cause:** MCP format violation — tool returned content without a text block
- **When this happens:** Never, in theory — all tools should wrap results in text blocks via `mcp-server-tools--format-result`

---

## 2. Elisp: Tool Registration & Dispatch

**File:** `packages/emacs/elisp/pi-emacs-tools.el` (lines 154-179)

```elisp
;; Tool registration
(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-navigate"
  :title "Code Navigate"
  :description "Navigate the treesit parse tree..."
  :input-schema '(...)
  :function #'pi-navigate-handler))

;; Handler wraps execution in error handling
(defun pi-navigate-handler (args)
  "Handle code-navigate tool call with ARGS."
  (condition-case err
      (let ((file (alist-get 'file args))
            (action (alist-get 'action args))
            (line (alist-get 'line args))
            (column (alist-get 'column args)))
        (pi-navigate-execute file action line column))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))
```

**Key Point:** Handler catches errors and returns JSON. Result is wrapped by MCP server machinery in a text content block.

---

## 3. Elisp: Core Navigation Implementation

**File:** `packages/emacs/elisp/pi-edit.el` (lines 102-218)

This is where the actual tree navigation happens. Let me trace each action:

### 3.1 File Opening & Position Setup

```elisp
(defun pi-navigate-execute (file action line column)
  "Execute a navigation ACTION on FILE at LINE/COLUMN."
  (let ((buf (pi-treesit-open-file file)))
    (unwind-protect
        (with-current-buffer buf
          (when line
            (goto-char (point-min))
            (forward-line (1- line))              ;; Line adjustment: convert 1-indexed to 0-indexed offset
            (when column (forward-char (1- column))))  ;; Column adjustment: same
          ;; ...action dispatch...
          )))
```

**Position Translation (Crucial):**
- **Input:** `line` and `column` are 1-indexed (from TypeScript)
- **Emacs:** `point-min` is position 1 (1-indexed)
- **Translation:** `forward-line (1- line)` moves to the start of the target line
- **Column translation:** `forward-char (1- column)` moves to 1-indexed position within the line
- **Issue:** If `line=1, column=1`, this moves to position 1 (correct)

**Buffer Opening (pi-treesit.el, lines 24-60):**
```elisp
(defun pi-treesit-open-file (file)
  "Open FILE with treesit parsing enabled, return buffer."
  (let ((buf (generate-new-buffer ...)))
    (with-current-buffer buf
      (insert-file-contents file)  ;; Read fresh from disk
      (let ((mode (pi-treesit--mode-for-file file)))
        (when (and mode (fboundp mode)) (funcall mode)))
      (unless (treesit-parser-list)
        (pi-treesit--activate-parser file))
      ;; Error if no parser available — ensures treesit is ready
      (unless (treesit-parser-list)
        (kill-buffer buf)
        (error "Tree-sitter grammar not available..."))
      buf)))
```

---

### 3.2 Action: node-at (Lines 144-159)

**What it does:** Return the node at the current position.

```elisp
("node-at"
 (let* ((pos (point))
        (node (treesit-node-at pos))
        (parent (when node (treesit-node-parent node)))
        (text (when node
                (let ((full (treesit-node-text node t)))
                  (car (split-string full "\n"))))))
   (if node
       `((type . ,(treesit-node-type node))
         (text . ,(if (> (length text) 80) (substring text 0 80) text))
         (line . ,(line-number-at-pos (treesit-node-start node)))
         (end_line . ,(line-number-at-pos (treesit-node-end node)))
         ,@(when parent
             `((parent . ((type . ,(treesit-node-type parent))
                         (line . ,(line-number-at-pos (treesit-node-start parent))))))))
     `((error . t) (message . "No node at position")))))
```

**Failure Mode #2: "No node at position" — when position contains no parse tree node**
- **Trigger:** `treesit-node-at pos` returns `nil`
- **Cause:** Position is in:
  - A blank line (only whitespace)
  - Pure comment text
  - Between tokens in whitespace
  - A file with no parse tree (parser unavailable)
- **Contract violation:** Returns error alist, but in correct JSON format — should be fine downstream

---

### 3.3 Action: defun-at (Lines 112-119)

**What it does:** Find the enclosing function/defun.

```elisp
("defun-at"
 (let ((node (treesit-defun-at-point)))
   (if node
       `((name . ,(or (pi-treesit-declaration-name node) "anonymous"))
         (type . ,(pi-treesit-declaration-kind node))
         (line . ,(line-number-at-pos (treesit-node-start node)))
         (end-line . ,(line-number-at-pos (treesit-node-end node))))
     `((error . t) (message . "No enclosing function found")))))
```

**Delegate:** `treesit-defun-at-point` — built-in Emacs function. Uses the grammar's `@function.outer` capture.

**Failure Mode #3: "No enclosing function found"**
- **Trigger:** Position is not inside a defun (e.g., at module level, in comments, in tests)
- **Contract violation:** Returns error alist — safe

**Helper: pi-treesit-declaration-name (pi-treesit.el, lines 193-320)**
- Maps treesit node types to declaration names
- 50+ language-specific node type handlers
- Returns `nil` for nodes without names → falls back to "anonymous"

**Helper: pi-treesit-declaration-kind (pi-treesit.el, lines 322-380)**
- Maps treesit node types to kind strings ("function", "class", "def", etc.)
- Language-aware

---

### 3.4 Action: parent (Lines 120-127)

**What it does:** Return the parent node of the node at point.

```elisp
("parent"
 (let* ((pos (point))
        (node (treesit-node-at pos))
        (parent (when node (treesit-node-parent node))))
   (if parent
       `((type . ,(treesit-node-type parent))
         (line . ,(line-number-at-pos (treesit-node-start parent))))
     `((error . t) (message . "No parent node")))))
```

**Failure Mode #4: "No parent node"**
- **Trigger:** Position has no node, or node is the root
- **Cause:** Same as node-at, plus root nodes have no parent
- **Contract violation:** Returns error alist

---

### 3.5 Action: references-local (Lines 128-143)

**What it does:** Find all references to the symbol at point **within the file**.

```elisp
("references-local"
 (let* ((pos (point))
        (node (treesit-node-at pos))
        (name (when node (treesit-node-text node t)))
        (root (treesit-buffer-root-node))
        (refs '()))
   (when (and name root)
     (treesit-search-subtree
      root
      (lambda (n)
        (when (string= (treesit-node-text n t) name)
          (push (line-number-at-pos (treesit-node-start n)) refs))
        nil)
      nil t 100))
   `((name . ,name) (references . ,(vconcat (nreverse refs))))))
```

**How it works:**
1. Get the node at point via `treesit-node-at pos`
2. Extract the node's text: `(treesit-node-text node t)` — **this is the symbol**
3. Search the root node's subtree for all nodes with the same text
4. Collect line numbers of matches
5. Return as alist with name and array of line numbers

**Failure Mode #5: Symbol lookup issues**
- **Problem 1:** `treesit-node-at pos` returns a node, but **not the symbol node**
  - Example: If you're at a space after `const`, `treesit-node-at` might return the whitespace node or the next token
  - The text extracted is then the wrong thing ("const" instead of the actual symbol name)
  
- **Problem 2:** "The symbol parameter" doesn't exist
  - The code.ts schema advertises a `symbol` optional parameter, but it's **never passed to navigate**
  - The implementation **ignores** it entirely
  - It always uses the node at the position
  - **Context:** From user report: "when I asked for resolvedCwd, it returned references for const, not the symbol I wanted"
    - This suggests the position landed on `const` keyword, not on `resolvedCwd` identifier
    - The code correctly extracted "const" and found all references to "const"
    - User expected the symbol parameter to override this, but it doesn't exist

- **Problem 3:** Text-based matching is literal
  - Finds all nodes with identical text
  - Cannot distinguish between `foo` the function and `foo` the variable
  - Cannot understand scoping (local vs global)
  - Will match comment text, string literals containing the symbol, etc.

---

### 3.6 Action: siblings (Lines 160-192)

**What it does:** List all sibling nodes of the current node.

```elisp
("siblings"
 (let* ((pos (point))
        (node (treesit-node-at pos))
        ;; Walk up past leaf/punctuation to nearest named node
        (named (when node
                 (if (treesit-node-check node 'named)
                     node
                   (treesit-node-parent node))))
        (parent (when named (treesit-node-parent named)))
        (children (when parent ... )))
   ;; Return list of siblings with current marked
   ))
```

**Key design:** Walks up to the nearest "named node" (skips punctuation/operators)

---

### 3.7 Action: children (Lines 193-216)

**What it does:** List child declarations of the node at point.

```elisp
("children"
 (let* ((pos (point))
        (node (treesit-node-at pos))
        ;; Walk up to a node that has a body
        (structural (when node
                      (let ((n node))
                        (while (and n (not (pi-treesit-find-body n)))
                          (setq n (treesit-node-parent n)))
                        n)))
        (body (when structural (pi-treesit-find-body structural)))
        ...)
   ;; Return list of child declarations
   ))
```

**Responsibility:** Walk up until finding a node with a body (class_body, statement_block, etc.), then extract children.

---

## 4. MCP Content Block Wrapping

**File:** `packages/emacs/elisp/vendor/mcp/mcp-server-tools.el` (lines 229-262)

All tool results are processed by `mcp-server-tools--format-result`:

```elisp
(defun mcp-server-tools--format-result (result)
  "Format RESULT into MCP content format."
  (cond
   ;; Already in MCP format (vector of content items).
   ((vectorp result)
    result)
   
   ;; Single content item alist with a 'type key.
   ((and (listp result) (not (null result)) (alist-get 'type result))
    (vector result))
   
   ;; String — wrap as text.
   ((stringp result)
    (vector `((type . "text") (text . ,result))))
   
   ;; nil — no results
   ((null result)
    (vector '((type . "text")
              (text . "{\"result\":null,\"warning\":\"Tool returned nil...\"}"))))
   
   ;; Any other list (alists, arrays) — JSON-encode it
   ((listp result)
    (vector `((type . "text")
              (text . ,(json-encode result)))))
   
   ;; Fallback: format %S, wrap in JSON
   (t
    (vector `((type . "text")
              (text . ,(json-encode `((result . ,(format "%S" result))))))))))
```

**Key Point:** All results end up as `(vector '((type . "text") (text . ...)))` — guaranteed to have a text block.

**"No text content block" error cannot happen here unless:**
1. MCP server itself is broken (doesn't call format-result)
2. Response is corrupted in transit (socat issue)
3. JSON parsing fails silently

---

## 5. Position & Indexing Semantics

### 5.1 TypeScript Input (1-indexed)

```typescript
line: 1  // First line of file
column: 1  // First character of line
```

### 5.2 Emacs Buffer Positions (1-indexed)

```elisp
(point-min)           ;; Position 1 = before first character
(goto-char 1)         ;; Move to position 1
(forward-line (1- n)) ;; Move to line n (1-indexed)
(forward-char (1- c)) ;; Move to column c (1-indexed)
(treesit-node-start n) ;; Returns buffer position (1-indexed)
```

### 5.3 Tree-sitter Node Positions (1-indexed)

```elisp
(treesit-node-at pos)  ;; Node containing buffer position
(treesit-node-start n) ;; Start position (1-indexed)
(treesit-node-end n)   ;; End position (exclusive)
```

**Translation is correct:** 1-indexed in → 1-indexed Emacs → 1-indexed tree-sitter

---

## 6. Complete Failure Mode Reference

| # | Failure | Root Cause | Symptoms | Recovery |
|---|---------|-----------|----------|----------|
| 1 | No text content block | MCP response malformed (impossible in theory) | Tool call times out or throws "returned no text content block" | Restart Emacs daemon |
| 2 | node-at returns error | Position has no node (blank line, whitespace, comment) | `{"error":true,"message":"No node at position"}` | Move to a token-containing position |
| 3 | defun-at error | Not inside a function | `{"error":true,"message":"No enclosing function found"}` | Move inside a function body |
| 4 | parent error | Position has no node, or is root | `{"error":true,"message":"No parent node"}` | Move to a position with a node |
| 5a | references-local wrong symbol | Node at position is not the symbol | Returns references for whitespace, operator, or wrong identifier | Adjust line/column to point at the symbol itself |
| 5b | references-local missing symbol parameter | Schema advertises `symbol` param, code doesn't use it | Cannot explicitly request references for a name | Remove the param from schema, or implement it |
| 5c | references-local too broad | Text-based matching finds comments, strings | User sees unwanted matches in non-code | Use tree-sitter node type filters instead of text matching |

---

## 7. Critical Issues & Root Causes

### Issue A: references-local Does Not Use Symbol Parameter

**Location:** `pi-edit.el` line 102 function signature vs line 128-143 action implementation

**Problem:**
- Schema in `code.ts` line 46 advertises optional `symbol` parameter
- `pi-navigate-handler` receives this in `args` but doesn't extract it
- `pi-navigate-execute` doesn't accept `symbol` parameter at all
- Action "references-local" ignores the parameter entirely

**Root Cause:** Feature was designed but never completed — the Elisp side was never updated to accept or use the symbol parameter.

**Impact:** Users cannot query references by name; they must position the cursor correctly.

---

### Issue B: "No Text Content Block" Trap

**Location:** `client.ts` line 198-200

**Problem:**
```typescript
const textBlock = parsed.result.content.find(c => c.type === "text");
if (!textBlock) {
    throw new Error(`Tool "${name}" returned no text content block`);
}
```

**Why it misleads:**
- Error message is accurate for the symptom, but there's no normal code path that produces this
- User sees this error during navigate, assumes it's a tool failure
- Actually indicates a malformed MCP response (network issue, server crash, etc.)
- User cannot distinguish between "tool failed to find node" (normal) vs "MCP transport broke" (exceptional)

**Root Cause:** Two different error types conflated:
1. Normal tool failures: "no node at position" → returned in result alist
2. Exceptional failures: MCP response broken → thrown as exception

**Why it happens with navigate:** Elisp returns an alist like `((error . t) (message . "No node at position"))`. This is formatted into JSON by format-result, wrapped in a text block. But if somehow an error bubbles up uncaught and the handler returns nil, that nil gets wrapped in a different way, potentially producing no text block.

---

### Issue C: Position-Sensitivity Without Guidance

**Location:** `pi-navigate-execute` lines 107-110

**Problem:**
```elisp
(when line
  (goto-char (point-min))
  (forward-line (1- line))
  (when column (forward-char (1- column))))
```

**Why it's hard to use:**
- `line` is required for some actions (node-at, parent, references-local) but the schema doesn't enforce this
- If you call `node-at` without line/column, you get "No node at position" (error alist)
- No clear error message saying "you must provide line and column"
- Position-based APIs are inherently fragile — off-by-one errors are silent

**Root Cause:** Loosely typed parameter passing; no validation or contract enforcement.

---

### Issue D: Tree-sitter Node At Position Is Not Always The Symbol

**Location:** `pi-navigate-execute` line 131

**Problem:**
```elisp
(node (treesit-node-at pos))  ;; Might return whitespace, operator, punctuation, etc.
(name (when node (treesit-node-text node t)))  ;; Extracts wrong text
```

**Why it breaks references-local:**
- If you position on `const x = ...` and point is after `const`, the node might be the identifier `x`, or whitespace, or the equals sign
- Behavior is grammar-dependent and undocumented
- User expects "find references to the symbol at this position"
- Gets "find references to whatever treesit-node-at happened to return"

**Root Cause:** Reliance on implicit tree-sitter semantics without explicit symbol extraction.

---

## 8. Architecture Summary

```
code.ts (TypeScript)
    ↓ [line, column 1-indexed]
client.ts (TypeScript)
    ↓ [JSON-RPC over socat]
Emacs daemon (MCP server)
    ↓ [mcp-server-tools]
pi-emacs-tools.el (Elisp tool registry)
    ↓ [pi-navigate-handler]
pi-edit.el::pi-navigate-execute (Elisp core logic)
    ↓ [uses treesit-node-at, treesit-defun-at-point, etc.]
tree-sitter library (C)
    ↓ [parse tree queries]
Parse tree (in-memory)
    ↓ [returns nodes, text, positions]
pi-edit.el [constructs result alist]
    ↓
mcp-server-tools--format-result (wraps in MCP content block)
    ↓
JSON-RPC response [with text block guaranteed]
    ↓ [socat transport]
client.ts::callToolOnce
    ↓ [extracts text block]
JSON.parse(textBlock.text)
    ↓
Tool result in agent
```

---

## 9. Key Discoveries

1. **No symbol parameter in Elisp** — The feature is half-designed. Schema allows it, Elisp ignores it.

2. **Position-based API is fragile** — Requires caller to understand tree-sitter node boundaries. Off-by-one errors are silent.

3. **Text-based matching is too broad** — references-local finds all text matches, including comments and strings.

4. **Error messages don't distinguish normal from exceptional failures** — "No node at position" (normal, returns in result) vs "MCP transport broken" (exceptional, throws).

5. **defun-at depends on grammar's @function.outer** — If the grammar doesn't define this, defun-at always fails.

6. **Parent action is minimal** — Only returns node type and line, no name or children info.

7. **Siblings/children walk up the tree** — They're more useful than node-at/parent for understanding structure.

8. **Buffer management is session-scoped** — Buffers are cached in `pi-buffer--registry` per session. Different sessions don't share state.

---

## 10. Why navigate is 2/5, Not 5/5

1. **Position sensitivity without validation** — Silent failures when off by one
2. **References-local is unreliable** — Text-based matching, wrong node selection
3. **Symbol parameter unadvertised as unsupported** — Leads to user confusion
4. **No way to query by symbol name** — Must position cursor correctly
5. **Error messages conflate normal vs exceptional** — User can't tell if they made a mistake or the tool broke
6. **Defun-at grammar-dependent** — Fails silently if @function.outer not defined
7. **Missing semantic understanding** — Can't distinguish scope, type, or purpose of symbols

---

## 11. Recommendation: Path to 5/5

### Immediate Wins (1-2 days)

1. **Add symbol parameter support to references-local**
   - Modify `pi-edit.el::pi-navigate-execute` to accept symbol parameter
   - Extract symbol from function signature if provided
   - Use for searching instead of treesit-node-text

2. **Add line/column validation**
   - Return clear error if line/column missing for position-based actions
   - Document which actions require position vs symbol

3. **Fix type-based matching in references-local**
   - Use `(treesit-node-type n)` filters in addition to text matching
   - Option to search for declarations only, or specific node types

### Medium-term (1 week)

4. **Improve node-at error messages**
   - Add context: "blank line", "whitespace", "comment"
   - Suggest nearby tokens

5. **Extend parent action**
   - Return parent name and kind, not just type
   - Return siblings for context

6. **Add scope-aware reference search**
   - Use tree-sitter queries for scope information
   - Filter references by scope (local, global, imported)

### Long-term (2-3 weeks)

7. **Integrate with LSP for semantic queries**
   - Fall back to LSP for symbol resolution when treesit is insufficient
   - Use LSP for precise type information, scope analysis, call graph

8. **Add explicit AST node query API**
   - Separate "navigate by position" from "query by symbol"
   - Make both ergonomic

9. **Complete Elisp/TypeScript contract alignment**
   - Update types.ts to include all supported operations
   - Document position vs symbol semantics
   - Add tests for each action on multiple languages
