Applies diff hunks to existing files.

<instruction>
- Use the smallest edit that uniquely identifies the change
- If an anchor is not unique, add context or use `all: true`
- Read the target file before editing
- Copy anchors and context lines verbatim, including whitespace
- When editing structured blocks, include opening and closing lines so the edit stays inside the block
- Do not use anchors as comments, place new lines outside the intended block, retry the same failing diff, or use this tool to reformat or fix indentation
</instruction>

<parameters>
```ts
type T =
  | { path: string, op: "update", diff: string }
  | { path: string, op: "create", diff: string }
  | { path: string, op: "delete" }
  | { path: string, op: "update", rename: string, diff: string }
```
</parameters>

<output>
Success or failure; failures report whether anchors are ambiguous, context is stale, or the diff is malformed.
</output>

<bash-alternatives>
Use Replace when content identifies location. Use bash only when position or regex identifies the change.
</bash-alternatives>
