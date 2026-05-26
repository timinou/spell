# W2 Review Findings: config.rs + defaults.kdl

Review of commit `796f53dbc` on branch `plan-319-semantic-backend`.
13 tests pass. 5 findings below.

---

## [P1] merge() unconditionally overwrites scalars with defaults, clobbering user-configured values

**File:** `crates/pi-code-graph/src/semantic/config.rs:148-163`

**Bug:** When a higher-priority layer's KDL doesn't mention a scalar (e.g. `max-warm-servers`), `parse()` populates it from `SemanticConfig::default()`. `merge()` then unconditionally overwrites the lower layer's explicitly configured value with this default.

**Trigger:**
```
Defaults:  bm25 { incremental #true }          → bm25_incremental = true
User:      bm25 { incremental #false }         → bm25_incremental = false
Project:   semantic { max-warm-servers 2 }     → bm25_incremental = true (Rust default, NOT in KDL!)
```

**load_layered trace:**
```
config = defaults()                              → bm25_incremental = true
config = merge(user_cfg, config)                 → bm25_incremental = false  ✓
config = merge(project_cfg, config)              → bm25_incremental = true   ✗ BUG
```

The project config's unmentioned `bm25_incremental` starts as Rust default (true) from `parse()`, then `merge()` unconditionally overwrites the merged value — clobbering the user's explicit `false` setting.

**Affected fields:** idle_ttl, max_warm_servers, request_timeout, sync_debounce, bm25_incremental.

**Root cause:** `merge()` has no notion of "not set" — it treats all scalars as always-present. The `parse()` → `Self::default()` pattern means unmentioned KDL fields carry Rust defaults that leak through merge.

**Suggested fix:** Track which scalars were explicitly parsed (e.g. a bitmask or `Option<T>` internally), and in `merge()`, only overwrite when `higher` explicitly set the value.

---

## [P2] read_positional_string reports "missing required field" when value exists but has wrong type

**File:** `crates/pi-code-graph/src/semantic/config.rs:298-305`

**Bug:** When a KDL entry has a non-string value (e.g. `lsp 42`), `read_positional_string` returns `MissingField` instead of a type-mismatch error. The entry IS present; the error message misleads.

```rust
fn read_positional_string(node: &KdlNode, field: &str) -> Result<String, ConfigError> {
    node.entries()
        .first()
        .and_then(|e| e.value().as_string().map(String::from))
        .ok_or_else(|| ConfigError::MissingField {  // ← wrong: not missing, wrong type
            node:  node.name().value().to_string(),
            field: field.into(),
        })
}
```

For `lsp 42`: `as_string()` returns None → returns `MissingField { node: "lsp", field: "lsp" }` → displays as `node 'lsp' missing required field 'lsp'`.

**Suggested fix:** Split into two arms — check for presence first, then check type. Return `BadValue` for type mismatches.

```rust
fn read_positional_string(node: &KdlNode, field: &str) -> Result<String, ConfigError> {
    let entry = node.entries().first().ok_or_else(|| ConfigError::MissingField {
        node: node.name().value().to_string(),
        field: field.into(),
    })?;
    entry.value().as_string().map(String::from).ok_or_else(|| ConfigError::BadValue {
        node: node.name().value().to_string(),
        message: format!("expected string for `{field}`, got {:?}", entry.value()),
    })
}
```

---

## [P2] node_to_json_value has unbounded recursion — stack overflow on deeply nested init-options

**File:** `crates/pi-code-graph/src/semantic/config.rs:337-354`

**Bug:** Recursive descent with no depth limit. A deeply nested `init-options` block can overflow the stack at runtime.

While user config is trusted input, this is a denial-of-service vector.

**Fix:** Add a depth counter with a limit (e.g. 64), returning `Value::Null` or an error on overflow.

---

## [P3] node_to_json_value drops positional entries when node has both entries and children

**File:** `crates/pi-code-graph/src/semantic/config.rs:342-348`

**Bug:** KDL allows nodes with both positional entries and child blocks (`cargo "rust" { allFeatures #false }`). The code checks `child.children().is_some()` first → true → recurses without inspecting `child.entries()`. The positional entry `"rust"` is silently dropped.

Result: `{"allFeatures": false}` instead of preserving `"rust"`.

Unlikely in typical LSP init-options but represents silent data loss.

---

## [P3] kdl_value_to_json silently truncates KDL integers from i128 to i64

**File:** `crates/pi-code-graph/src/semantic/config.rs:359`

**Bug:** `KdlValue::Integer(i)` stores `i128`. `*i as i64` silently truncates for values outside i64 range, producing incorrect JSON.

Low impact (LSP config rarely uses such values) but lossy with no warning.

---

## Areas NOT flagging as bugs

| Concern | Verdict |
|---|---|
| parse_server partial-state on error | ✓ Correct — `insert` happens AFTER `command.is_empty()` check (line 288), not before. |
| validate cross-file server-ref removal | ✓ Correct — removing lsp ref from language handles the case. Can't delete server keys from lower layers, but that's a missing feature (explicit deletion mechanism), not a bug. |
| defaults.kdl panic at startup | ✓ By design — docstring explicitly says "Infallible — a panic here indicates a bug in the bundled defaults file." Compile-time bundled, tests verify. |
| KDL injection / ReDoS | ✓ KDL parser is not regex-based. No ReDoS vector. |
| KDL parse error Debug format | ✓ Minor — `{e:?}` includes line/col info, arguably more useful than Display. |
| read_u64 negative reject | ✓ Correct — `i128::try_from(i)` returns Err for negatives. |
| env var name validity | ✓ KDL identifiers allow `[A-Za-z_-]` starts. Hyphens work in Unix env vars (unusual but valid). Defaults only use `[A-Za-z_]` names. |
| HOME vs XDG_CONFIG_HOME | ✓ Deliberate — `~/.spell/` matches tool conventions (like `.ssh`, `.docker`). Not XDG but intentional. |
| Test env::set_var race | ✓ Acknowledged via `unsafe` blocks. Low-probability test-only issue. |
| PartialEq key-only comparison | ✓ Only used in `parse_returns_default_when_no_semantic_block` where both sides have empty maps. Harmless. |
| Unicode box-drawing in comments | ✓ KDL `//` comments accept any characters. |
| Env var ordering determinism | ✓ `KdlDocument` uses `Vec` internally; iteration is document-order (deterministic). |
| Dead imports (PathBuf, _dirs_dep) | P3 — compiler warnings, not functional bugs. |
