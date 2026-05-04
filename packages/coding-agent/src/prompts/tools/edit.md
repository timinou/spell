Perform structural code edits, LINE#ID-based text edits, or apply unified diffs. Supports 18+ action kinds with occurrence selectors and idempotent semantics.

<instruction>
- Each operation has a `target` (file path or `file.ts::Symbol.member`) and an `action`.
- Action kinds fall into three families:
  - **Structural** (tree-sitter): `write`, `findAndReplace`, `rawTextReplace`, `wrap`, `rename`, `delete`, `insertBefore`, `insertAfter`, `splice`, `move`, `clone`, `transpose`, `renameClassToken`, `renameIdToken`, `renameCustomProperty`, `removeDeadStyle`, `promote`, `demote`, `replaceCodeBlock`.
  - **LINE#ID** (text): `replace`, `append`, `prepend` using anchors copied from `get` output (e.g. `42#AB`).
  - **Patch**: `patch` with a unified diff string.
- `occurrence` disambiguates duplicates: `first`, `last`, `all`, or `1`-indexed number. Default is unique-or-fail.
- `idempotent=true` allows an edit to succeed when it produces no semantic change. Set only when a no-op is expected.
- `force=true` bypasses write-shrink and parse-regression guards. Use only when deliberately replacing a file wholesale.
- LINE#ID edits detect stale anchors: if the line hash mismatches, the tool returns a diagnostic with the current file state. Re-read and retry with fresh anchors.
- `children` enables nested operations under the same root target tree.
- `scope: "body"` restricts writes to a declaration body; prefer the `#body` qualifier in the target path when dialects support it.
</instruction>

<output>
- Returns structured diff with applied changes, affected line ranges, and any diagnostics.
- Stale anchor errors include current file state for re-anchoring.
- Parse errors include tree-sitter diagnostic details.
</output>

<examples>
**Structural edits:**
```
edit { operations: [{ target: "src/server.ts::handleRequest", action: { kind: "findAndReplace", find: "timeout", content: "deadline" } }] }
edit { operations: [{ target: "src/config.ts", action: { kind: "findAndReplace", find: "legacyApi", content: "modernApi", occurrence: "all" } }] }
edit { operations: [{ target: "src/app.ts::App.handle", action: { kind: "wrap", content: ["try {", "  $BODY", "} catch (e) {", "  throw e;", "}"] } }] }
edit { operations: [{ target: "src/auth.ts::validateToken", action: { kind: "rename", content: "verifyToken" } }] }
edit { operations: [{ target: "src/old.ts::legacyFn", action: { kind: "delete" } }] }
```

**LINE#ID edits:**
```
edit { operations: [{ target: "src/server.ts", action: { kind: "replace", pos: "42#AB", end: "45#CD", lines: ["const x = 1;"] } }] }
edit { operations: [{ target: "config.txt", action: { kind: "append", pos: "10#XY", lines: ["new line"] } }] }
```

**Patch mode:**
```
edit { operations: [{ target: "src/server.ts", action: { kind: "patch", diff: "--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1,3 +1,3 @@\n-foo\n+bar\n" } }] }
```

**Nested edits:**
```
edit { operations: [{ target: "src/server.ts::Server", action: { kind: "wrap", content: ["try {", "  $BODY", "}"] }, children: [{ target: "src/server.ts::Server.handle", action: { kind: "findAndReplace", find: "legacyCall()", content: "modernCall()" } }] }] }
```

**Multi-file batch:**
```
edit { operations: [
  { target: "src/api.ts::Api.fetch", action: { kind: "findAndReplace", find: "timeout", content: "deadline" } },
  { target: "src/config.ts", action: { kind: "findAndReplace", find: "const timeout = 5000", content: "const timeout = 30000" } }
] }
```
</examples>

<critical>
- You **MUST** use `edit` instead of legacy `code edit`, `ast-edit`, or `write` for mutations.
- You **MUST NOT** use `write` to modify existing files; use `create` for new files and `edit` for mutations.
- For non-code text changes outside tree-sitter support, LINE#ID or patch mode is acceptable.
- Successful managed edits do not require a fresh `get` before the next edit; if an edit fails, tighten the target/action and retry narrowly.
- When using LINE#ID anchors, always copy them from fresh `get` output to avoid stale-anchor errors.
</critical>
