Performs strict LINE#ID-based edits in existing files using anchors copied from `read` output.

<instruction>
- Use when editing unsupported plain-text files and you need line-addressed safety instead of fuzzy text matching
- Copy `pos` / `end` exactly from `read` output in `LINE#ID` format
- `replace` requires at least one valid anchor in `pos` or `end`
- `replace` with a single anchor (pos or end only) replaces exactly one line; `lines.length` must be 1 (or 0 to delete). To replace multiple lines, supply both `pos` and `end`
- `append` / `prepend` may omit anchors only for file-level inserts at EOF / BOF
- Prefer the smallest edit span that fully owns the construct you are changing
- If the file changed since you last read it, re-read and retry with the fresh LINE#ID values
</instruction>

<output>
- Returns success with an edit summary and diff preview
- Fails distinctly for missing anchors, malformed anchors, stale hashes, and span mismatches
- Stale-hash failures show updated `LINE#ID` values so you can retry against the current file
</output>

<critical>
- Read the file before editing; do not invent anchors
- `LINE#ID` means the exact `NUMBER#HASH` token from `read` output, not raw line text or a bare line number
- Do not guess, widen, or fall back to whole-file replacement when anchors fail
- If `pos` / `end` are malformed or stale, stop, re-read, and retry with exact anchors
- If you used only one anchor but supplied more than one line, the edit is rejected. Recovery: add `end` for a range replace, or trim `lines` to length 1
</critical>

<examples>
- Single-line replace: `{ "path": "Cargo.toml", "edits": [{ "op": "replace", "pos": "2#QW", "lines": ["version = \"0.2.0\""] }] }`
- Range replace: `{ "path": "notes.txt", "edits": [{ "op": "replace", "pos": "10#QW", "end": "12#MH", "lines": ["new line 1", "new line 2"] }] }`
- File-level append: `{ "path": "todo.txt", "edits": [{ "op": "append", "lines": ["- new item"] }] }`
</examples>

<counterexamples>
- Rejected (pos-only with multi-line content): `{ "path": "x.txt", "edits": [{ "op": "replace", "pos": "2#QW", "lines": ["a", "b"] }] }` — a single anchor replaces exactly one line. To replace a range, add `end`. To replace one line, trim `lines` to `["a"]`.
</counterexamples>