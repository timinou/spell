# Emacs Client Architecture Analysis

## Overview

The Emacs integration (`packages/emacs/`) provides structured code intelligence via Emacs 29+ with tree-sitter and combobulate. It has two functional halves:
1. **File-local operations**: Emacs treesit + combobulate (read, outline, navigate, edit, buffers, diff, languages, install_grammar)
2. **Cross-file graph operations**: Delegated to native code graph engine (index, status, context, impact, deps, flow, dead_code, clusters, search)

## Architecture: Communication Layer

### Transport: socat + JSON-RPC 2.0

The TypeScript client communicates with the Emacs daemon exclusively through **socat stdio bridge over a Unix socket**, using **JSON-RPC 2.0** protocol:

```
TypeScript Client
    ↓
socat (STDIO → UNIX-CONNECT)
    ↓
Emacs MCP Server (listening on Unix socket)
    ↓
Elisp Tool Handlers
```

**Key design decision**: Every tool call opens a fresh socat connection, sends one request, reads one response, then closes. No persistent connection; no multiplexing. This provides isolation and simplicity at the cost of per-call overhead (~few hundred ms on cold daemon).

### Daemon Lifecycle

**packages/emacs/src/daemon.ts**:
- **Start**: `startEmacsSession()` spawns `emacs --fg-daemon=spell-emacs-<hash>` with:
  - Elisp load-path pointing to `packages/emacs/elisp/`
  - Prelude eval: `(require 'pi-prelude)` → tree-sitter bootstrap
  - MCP server start: `(require 'pi-emacs-mcp)` → `(mcp-server-start-unix nil "/tmp/spell-emacs-<hash>.sock")`
- **Reattachment**: Sessions cached globally; if a process crashes, a new one respawns on next `getSession()` call
- **Health**: Daemon monitored via socket existence; reattached daemons get periodic health checks

**Session manager** (packages/emacs/src/session-manager.ts):
- Circuit breaker: 3 consecutive startup failures → 60s cooldown, then mark "unavailable"
- Prevents thrashing when Emacs is missing or treesit fails to build grammars

---

## Type Definitions: What's Promised vs. What's Implemented

### CodeClient Interface (types.ts)

```typescript
export interface CodeClient {
  read(file, resolution?, offset?, limit?): Promise<string>
  outline(file, depth?): Promise<OutlineEntry[]>
  edit(op: CodeEditOp): Promise<CodeEditResult>
  buffers(): Promise<BufferInfo[]>
  bufferDiff(file): Promise<string>
  navigate(file, action, line?, column?): Promise<unknown>
  languages(installedOnly?): Promise<LanguageInfo[]>
  installGrammar(lang, url?, revision?, sourceDir?): Promise<InstallResult>
  callTool(name, args): Promise<unknown>
  close(): Promise<void>
}
```

**Mismatch #1: `close()` is a no-op**
- Type promises async cleanup
- Implementation (client.ts:97-99): `async close(): Promise<void> { /* nothing */ }`
- Reality: socat connections are closed automatically after each `callToolOnce()` call
- **Risk**: Callers may assume resources are freed; they're already freed (safe but misleading)

### CodeEditOperation (types.ts:27-36)

```typescript
export type CodeEditOperation =
  | "replace" | "insert-before" | "insert-after" | "splice"
  | "drag-up" | "drag-down" | "clone" | "kill" | "envelope"
```

**Mismatch #2: Type lists 9 operations; Elisp supports 11; agent schema lists 13**

- **TypeScript types** (types.ts): `replace`, `insert-before`, `insert-after`, `splice`, `drag-up`, `drag-down`, `clone`, `kill`, `envelope`
- **Elisp implementation** (pi-edit.el): Also supports `transpose`, `splice-self`, `splice-down`
- **Agent schema** (coding-agent/src/tools/code.ts:55): Describes `splice-self`, `splice-down`, `drag-up`, `drag-down`, `transpose`

**Root cause**: TypeScript types only enumerate the subset tested/documented, but Elisp has always supported more. The agent schema is broader but TypeScript won't catch invalid values at the API boundary.

---

## Error Handling: From Elisp to TypeScript

### Protocol: JSON Encoding at Each Layer

**Elisp layer** (pi-emacs-tools.el: lines 17-23, 45-62, etc.):
```elisp
(condition-case err
  (let* ((file (alist-get 'file args)))
    (pi-resolution-read file resolution offset limit))
  (error (json-encode `((error . t) (message . ,(error-message-string err))))))
```

Each tool handler wraps its work in `condition-case`. On error:
- Catches the exception
- Encodes an alist `((error . t) (message . "..."))` as JSON
- Returns it as a **success** response (no JSON-RPC error)

This means **all errors are surfaced as successful responses with an error field**.

### MCP Server layer (vendor/mcp/mcp-server-tools.el:222-227):
If the tool handler throws *during* function dispatch (before the handler's own error wrapping):
```elisp
(condition-case err
  (let ((result (funcall (mcp-server-tool-function tool) arguments)))
    (mcp-server-tools--format-result result))
  (error (vector `((type . "text")
                   (text . ,(format "Tool execution failed: %s" (error-message-string err)))))))
```
This returns a **text content block** describing the failure.

### TypeScript client layer (client.ts:184-209):

```typescript
if (isJsonRpcError(parsed)) {
  const { code, message, data } = parsed.error;
  logger.warn("[emacs-client] JSON-RPC error", { name, code, message, data });
  throw new Error(`Emacs MCP error ${code}: ${message}`);
}

const textBlock = parsed.result.content.find(c => c.type === "text");
if (!textBlock) {
  throw new Error(`Tool "${name}" returned no text content block`);
}

try {
  return JSON.parse(textBlock.text) as unknown;  // ← Parse inner JSON
} catch {
  return textBlock.text;  // ← Or return raw text
}
```

The client:
1. **Checks for JSON-RPC error** (protocol-level failure) → throws
2. **Extracts the text block** from the MCP content array
3. **Attempts to parse it as JSON** (inner encoding from Elisp):
   - If Elisp tool returned `((error . t) (message . "..."))` as JSON → parses to an object with `error: true`
   - If it returned plain text → returns the string

**Key insight**: Errors are NOT thrown by callToolOnce. They return success with a `{ error: true, message: "..." }` object. The caller must inspect the result.

### Agent tool layer (coding-agent/src/tools/code.ts:129-146):

```typescript
const result = await this.#inner.execute(args);
const text = JSON.stringify(result, null, 2);
const isError =
  typeof result === "object" &&
  result !== null &&
  "error" in result &&
  (result as Record<string, unknown>).error === true;
return {
  content: [{ type: "text", text }],
  details: isError ? { error: true, command } : { command },
};
```

The agent inspects the result from the Emacs client. If it has `error: true`, it flags it in details. Errors don't propagate as exceptions; they're embedded in the response.

---

## Operations Mapping: What the Client Actually Exposes

### File-Local Emacs Operations (client.ts)

All delegate to `callToolOnce(socat, socketPath, toolName, args)`:

| Method | Tool Name | Parameters | Returns |
|--------|-----------|-----------|---------|
| `read()` | `code-read` | `{file, resolution, offset?, limit?}` | JSON-parsed or raw text |
| `outline()` | `code-outline` | `{file, depth?}` | Array of `OutlineEntry` |
| `edit()` | `code-edit` | `CodeEditOp` (file, operation, target, content?, envelope?, save?) | `{success, diff?, error?}` |
| `buffers()` | `buffer-list` | `{}` | Array of `BufferInfo` |
| `bufferDiff()` | `buffer-diff` | `{file}` | Raw diff string |
| `navigate()` | `code-navigate` | `{file, action, line?, column?}` | Unknown (depends on action) |
| `languages()` | `code-languages` | `{installed_only?}` | Array of `LanguageInfo` |
| `installGrammar()` | `code-install-grammar` | `{lang, url?, revision?, source_dir?}` | `{success, lang, error?}` |
| `callTool()` | Generic dispatch | `{name, arguments: args}` | Parsed JSON or text |

**Mismatch #3: Return type for `navigate()` is `unknown`**
- Type system doesn't define what structure navigation returns
- Elisp code (pi-treesit-recipes.el) returns different shapes per action
- Agent can't statically validate what it receives

**Mismatch #4: Resolution type constraints**
- `read()` signature takes `Resolution` (0 | 1 | 2 | 3)
- Client.ts accepts it as-is; no validation
- If caller passes 4, Emacs will likely error, but error is returned as `{error: true, message: "..."}`

---

## Mismatches Between Types, Implementation, and Agent Usage

| # | Type | Implementation | Agent | Severity | Root Cause |
|----|------|---|---|----------|-----------|
| 1 | `close(): Promise<void>` | No-op | Called but unused | Low | Design: per-call socat, nothing to clean |
| 2 | CodeEditOperation: 9 ops | Elisp: 11 ops | Schema: 13 ops | Medium | TypeScript types only document subset; Elisp + agent went beyond |
| 3 | `navigate()` returns `unknown` | Returns per-action structure | No static validation | Medium | Navigation is polymorphic; type system gave up |
| 4 | `read(resolution?: Resolution)` | No validation | Caller must validate | Low | Runtime validation via Elisp error |
| 5 | Errors as `{error: true}` | Success + embedded error | Checked after parsing | Medium | Protocol conflates "success" with "contained error" |

---

## Error Reporting: How Truth Flows Back

1. **Elisp error** → caught by tool handler → encoded as `{error: true, message: "..."}` → returned as JSON string in text block
2. **Text block** → extracted by TypeScript client → JSON-parsed → returned as object with `error: true`
3. **Agent receives object** → inspects for `error: true` → flags in response details → user sees error embedded in tool result, not as exception

**Design principle**: Errors don't break the RPC loop. Everything succeeds at the protocol level; semantic failures are in the payload.

**Risk**: A confusing error that **looks like success but isn't**:
- Emacs crashes mid-operation → socat timeout → client throws exception
- Emacs file I/O fails → caught → returns `{error: true, message: "file not found"}`
- Caller doesn't check `error` field → processes the error message as content

---

## Key Architectural Patterns

### 1. Circuit Breaker Pattern (session-manager.ts)
- 3 consecutive failures → 60s cooldown
- Prevents daemon thrashing on bad system state (missing treesit, broken grammar, etc.)

### 2. Per-Call Isolation (client.ts:141-209)
- Each tool call is a fresh process: `Bun.spawn([socat, ...])` → stdin.write(json) → stdout.read() → kill()
- Pros: no persistent state, crashes don't propagate
- Cons: ~100-500ms per call overhead on cold daemon

### 3. Lazy Reattachment (daemon.ts:138-201)
- Daemon crashed? Next `getSession()` relaunches it
- Socket stale? Try to probe; if dead, remove and respawn
- Session is global; multiple callers in the same process share the same daemon instance

### 4. Error-as-Payload (pi-emacs-tools.el, client.ts, agent tool)
- Elisp catches everything and returns structured error objects
- TypeScript client doesn't throw; it returns the object
- Agent must inspect result.error field or JSON-parse the stringified object

---

## What's Weak / Not Yet Developed

### 1. Type Safety for Edit Operations
- TypeScript enumerates 9; reality has 11+
- No validation at the API boundary
- Agent schema is the source of truth, not types.ts

### 2. Navigate Return Types
- Polymorphic per action; type system gave up (`unknown`)
- Each action can return different structure (defun vs. siblings vs. children)
- No static contract between caller and implementation

### 3. Error Distinction
- Can't tell "operation succeeded with a warning" from "operation completely failed"
- Elisp can return `{warning: "..."}`; TypeScript ignores it
- Agent checks only for `error: true`

### 4. Timeout & Deadline Semantics
- `callToolOnce` has a 30s hard timeout (client.ts:138)
- But daemon startup can take 60-120s on first run (grammar compilation)
- Warmup happens separately; runtime calls never wait for warmup

### 5. Grammar Install Progress
- `installGrammar()` returns `{success, lang, error?}` (types.ts:63-67)
- Doesn't report progress during the compile
- Can take 1-10s; agent sees a silent delay

---

## Structural Overview

### Directory Layout
```
packages/emacs/
├── src/
│   ├── types.ts          ← All TypeScript interfaces (CodeClient, CodeEditOp, etc.)
│   ├── client.ts         ← JSON-RPC transport; socat bridge; callToolOnce()
│   ├── daemon.ts         ← Emacs process spawn, socket management, reattachment
│   ├── session-manager.ts ← Circuit breaker, recovery logic
│   ├── tool.ts           ← CodeToolDefinition factory; command dispatch
│   ├── detection.ts      ← Environment checks (Emacs version, treesit, socat)
│   └── index.ts          ← Re-exports
└── elisp/
    ├── pi-emacs-tools.el ← Tool handler registrations (code-read, code-outline, code-edit, etc.)
    ├── pi-edit.el        ← Edit operations (replace, splice, drag, clone, etc.)
    ├── pi-outline.el     ← Tree-sitter outline extraction
    ├── pi-treesit-recipes.el ← Grammar recipes (language configs)
    ├── pi-buffer.el      ← Buffer state tracking (open buffers, diff)
    ├── pi-navigate.el    ← Navigate tree (parent, siblings, children, references)
    ├── pi-resolution.el  ← Resolution levels 0-3 (read with zoom)
    ├── pi-prelude.el     ← Bootstrap; setup load-path, treesit cache
    └── vendor/mcp/       ← MCP server protocol implementation
```

---

## Integration Points

### 1. Daemon Startup (tool.ts:135-170)
```typescript
export async function warmupCode(
  projectRoot: string,
  sessionId: string,
  options?: CodeWarmupOptions
): Promise<CodeWarmupResult>
```
Called once per session (or when daemon crashes). Returns `{status: "ready"|"error"|"unavailable", session?, error?}`.

### 2. Coding Agent (coding-agent/src/tools/code.ts)
- Integrates emacs client via `createCodeTool()`
- Routes graph commands to native backend
- Wraps Emacs operations and formats results for agent

### 3. Org Tool (org/src/emacs/client.ts)
- Uses same `CodeClient` interface
- Calls `callTool("org-ql-query", ...)` for org queries

---

## Summary: What to Strengthen

1. **Types Should Match Elisp**: Keep CodeEditOperation in sync with pi-edit.el; add transpose, splice-self, splice-down
2. **Navigation Return Types**: Define a union of possible return types per action (defun, siblings, references, etc.)
3. **Error vs. Warning**: Distinguish success + warning from actual failure
4. **Timeout Configuration**: Allow callers to specify deadline; don't hardcode 30s
5. **Progress Reporting**: installGrammar and long-running operations should support incremental updates
6. **Resolution Validation**: Validate that resolution is in [0, 3] before sending to Emacs
7. **Test Coverage**: Current tests are light; add E2E tests for each operation against real Emacs
