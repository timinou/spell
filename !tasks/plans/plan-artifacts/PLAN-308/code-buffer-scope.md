# code_buffer.rs Scope Investigation (PLAN-308 Wave D)

## Q1: What does executeCodeBuffer offer that executeCodePath does not?

`execute_code_buffer_inner` at `crates/pi-natives/src/code_buffer.rs:1837` dispatches over many
commands (open, close, reload, outline, navigate, read, undo, redo, diff,
replace_content, save, watcherStatus, lockStatus, list, languages,
coord_status, coord_peer_activity, coord_journal_tail). The `"edit"` command
routes to `execute_edit_command` at line 1642.

`executeCodePath` at `crates/pi-natives/src/code_path/napi.rs:324` only handles
`command: "edit"` and `command: "resolve"`. Its edit branch applies `Op`
variants through mutation resolvers (FsResolver, TextResolver,
code_resolver, css_resolver, heading_resolver).

Key differences:

| Aspect | executeCodeBuffer (edit) | executeCodePath (edit) |
|---|---|---|
| State machine | In-memory session buffer (buffer_registry) | Direct-to-disk via resolvers |
| Version tracking | Yes (transaction.revision, diff) | No (only outcome nodes) |
| Rollback | Via edit_transaction + per-request save | Via strict-mode file snapshots |
| Operations format | TS JSON with `{kind, targetId, actions}` | Op JSON with `{kind, target, ...}` |
| Session awareness | Full (session_id, coord journal) | Limited (session_id passed to code resolver) |

**Bottom line:** `executeCodeBuffer` goes through the in-memory buffer state
machine with edit transactions, revision tracking, diff generation, and
coord-aware journaling. `executeCodePath` writes directly to filesystem via
resolvers with only strict-mode snapshot rollback.

## Q2: What are the actual consumers of executeCodeBuffer?

From the TS side (`packages/coding-agent/src/session/edit-coordinator.ts:27`
exported as `callCodeBuffer`):

| Callsite | Command | File | Lines |
|---|---|---|---|
| managed-code-buffer.ts:106 | `"edit"` | managed-code-buffer.ts | 106 |
| managed-code-buffer.ts:114 | `"replace_content"` | managed-code-buffer.ts | 114 |
| managed-code-buffer.ts:122 | `"save"` | managed-code-buffer.ts | 122 |
| edit-coordinator.ts:29+ | various | edit-coordinator.ts | dispatch layer |

The ONLY edit-path callsite is `managed-code-buffer.ts:106`:
```typescript
callCodeBuffer(
  { session: options.session },
  {
    command: "edit",
    root: process.cwd(),
    operations: [{ targetId: file, actions: [{ kind: "write", content }] }],
  },
)
```

All other callsites use non-edit commands (replace_content, save, open, etc.).

## Q3: Is managed-code-buffer.ts's `kind:"write"` usage replaceable by executeCodePath?

**No — semantic mismatch.**

`managed-code-buffer.ts:106` calls `callCodeBuffer` with
`command: "edit"`, operations containing `[{ kind: "write", content }]`.
This goes through `execute_edit_command` in code_buffer.rs, which:
1. Opens/creates a session buffer via `buffer_registry().open_or_create()`
2. Applies operations within `edit_transaction()` — the in-memory buffer state
   machine
3. Supports undo/redo, diff generation, version tracking, coord journaling
4. Persists to disk only when save mode requires it

`executeCodePath` (napi.rs) does NOT go through the buffer state machine. It
resolves targets and applies mutations directly to disk via FsResolver
(fs::write), TextResolver (fs::write with text queries), CodeResolver
(tree-sitter-backed edit logic), etc. There is no buffer registry
interaction, no edit transaction, no version tracking, no undo.

If managed-code-buffer.ts migrated to `executeCodePath`, it would lose:
- In-memory buffer state (subsequent reads would hit stale data)
- Undo/redo capability
- Edit transaction batching
- Coord/journal awareness
- Diff generation from buffer state

The buffer registry IS the session buffer state machine. `executeCodePath`
bypasses it intentionally for the simple edit path (find tool → code
resolver → filesystem). They serve different purposes.

## Q4: Recommendation

**(c)** Keep both; file Wave D' as a separate plan refactoring code_buffer.rs
to use Op internally.

**Rationale:**
- `executeCodeBuffer` provides genuine value (in-memory buffer state, undo,
  version tracking) that `executeCodePath` does not
- The only "edit" consumer (`managed-code-buffer.ts`) correctly uses the buffer
  state machine and should not migrate
- `code_buffer.rs` has ~57 legacy-kind dispatch sites
  (`apply_operations_transactionally` at line 1225) that internally dispatch
  via `ActionKind` — NOT `Action` enum — so they would NOT disappear even if
  Action enum is deleted. The internal dispatch uses a different kind string
  mapping, not the deprecated `Action` type from `pi-code-path`.
- Recommend filing a separate plan (Wave D') to refactor code_buffer.rs's
  internal operation dispatch to use Op types, but this is independent of the
  Action enum deprecation timeline

**Implication for Action enum removal (FUP-087):**
- code_buffer.rs does NOT import or use `pi_code_path::Action` enum. The
  deprecation of Action does not block or depend on code_buffer.rs refactoring.
- Action enum CAN be hard-removed in FUP-087 regardless of whether
  code_buffer.rs is refactored, because no code_buffer code depends on the
  `pi_code_path::Action` type.
