---
name: canvas
description: Spawn a native QML canvas window to display structured data (tables, diffs, trees, markdown, images) and collect user input via prompts. Use when presenting comparisons, tabular data, large diffs, or multi-step decisions.
version: 2.0.0
---

# Canvas

Rich structured-data display, interactive prompts, and tiered agent dispatch in native QML windows.

## When to use

Spawn a canvas when presenting:
- Comparison tables (>3 options)
- Tabular data (>5 rows)
- Large diffs (>50 lines)
- Hierarchical / tree data
- Multi-step decisions requiring user input
- Dashboard or monitoring surfaces
- Side-by-side layouts (use layout blocks)

Don't ask permission — spawn it and describe what you showed. If the display is unavailable, fall back to markdown in the chat.

## Display check

```typescript
import { isDisplayAvailable } from "@oh-my-pi/pi-qml";

if (!isDisplayAvailable()) {
  // render as markdown instead
}
```

`isDisplayAvailable()` checks for X11/Wayland on Linux; always true on macOS/Windows.

## Workflow

### 1. Check display availability

Call `isDisplayAvailable()` before attempting to spawn.

### 2. Launch the canvas

Use the built-in launcher directly:

```
qml launch id="canvas-<topic>" path="packages/coding-agent/src/modes/qml/canvas/CanvasLauncher.qml"
```

No wrapper QML needed — CanvasLauncher.qml provides the ApplicationWindow.

### 3. Populate content via messages

Use `qml send_message` with the protocol below.

### 4. Handle responses

When a user answers a prompt, the canvas emits a `respond` event via `bridge.send()`. Handle it in your event loop.

### 5. Close when done

Use `qml close` with the window id.

## Message protocol

All messages are JSON objects with an `action` field.

### `set` — replace all content blocks

```json
{
  "action": "set",
  "content": [
    { "id": "intro", "type": "markdown", "data": { "text": "# Report\nSummary below." } },
    { "id": "t1", "type": "table", "data": { "columns": [{"key": "name", "label": "Name", "width": 200}, {"key": "score", "label": "Score"}], "rows": [{"name": "Alice", "score": 95}, {"name": "Bob", "score": 87}], "sortable": true } }
  ]
}
```

### `append` — add blocks to the end

```json
{
  "action": "append",
  "content": [
    { "id": "note", "type": "markdown", "data": { "text": "Additional notes..." } }
  ]
}
```

### `remove` — remove a block by id

```json
{ "action": "remove", "id": "note" }
```

### `sync` — request current state

```json
{ "action": "sync" }
```

Response (via bridge event):
```json
{ "action": "state", "blocks": [...], "prompts": [...] }
```

### `update` — update a single block's data

```json
{ "action": "update", "id": "t1", "data": { ... } }
```

Updates the data of the block with the given id, preserving its type. If the id doesn't exist, no change occurs.

### `prompt` — ask user for input

```json
{
  "action": "prompt",
  "promptId": "choose-framework",
  "type": "radio",
  "question": "Which framework should we use?",
  "options": ["React", "Vue", "Svelte"]
}
```

Prompt types:
- **`radio`** — single selection from options (default). User clicks an option; response is the selected string.
- **`checkbox`** — multiple selection from options. User checks items and clicks Submit; response is an array of selected strings.
- **`text`** — free-form text input. User types and submits; response is the entered string.

Response event (from canvas):
```json
{ "action": "respond", "promptId": "choose-framework", "value": "Svelte" }
```

Sending a prompt with an existing `promptId` replaces the previous prompt.

## Component types

Each content block has `{ id, type, data }`. Supported types:

### `markdown`
Renders rich text via Qt's MarkdownText format.
```json
{ "id": "m1", "type": "markdown", "data": { "text": "# Title\nParagraph with **bold**." } }
```

### `image`
Displays an image from a URL or local path.
```json
{ "id": "img1", "type": "image", "data": { "url": "/path/to/image.png" } }
```
Also accepts `src` as an alias for `url`.

### `table`
Rendered by the DataTable component. Columns and rows of structured data.
```json
{
  "id": "t1", "type": "table",
  "data": { "columns": [{"key": "col_a", "label": "Col A"}, {"key": "col_b", "label": "Col B"}], "rows": [{"col_a": "val1", "col_b": "val2"}] }
}
```

### `diff`
Rendered by the DiffView component. Shows unified diffs with hunk structure.
```json
{
  "id": "d1", "type": "diff",
  "data": { "filename": "src/main.ts", "hunks": [{"header": "@@ -1,3 +1,4 @@", "lines": [{"type": "context", "text": "import foo"}, {"type": "remove", "text": "old line"}, {"type": "add", "text": "new line"}]}] }
}
```

### `tree`
Rendered by the TreeView component. Hierarchical data display.
```json
{
  "id": "tr1", "type": "tree",
  "data": { "nodes": [{"id": "src", "label": "src", "icon": "folder", "expanded": true, "children": [{"id": "main", "label": "main.ts", "icon": "file"}]}] }
}
```

### `layout`
Rendered by the LayoutContainer component. Arranges child blocks in rows, columns, or grids.
```json
{
  "id": "l1", "type": "layout",
  "data": {
    "direction": "row",
    "spacing": 8,
    "children": [
      { "id": "left", "type": "markdown", "data": { "text": "Left pane" } },
      { "id": "right", "type": "table", "data": { "columns": [...], "rows": [...] } }
    ]
  }
}
```
Direction options: `row` (horizontal), `column` (vertical, default), `grid` (wrapping grid). For grid, set `columns` to control wrap count. Supports nested layouts.

### `status`
Rendered by the StatusIndicator component. Compact agent state visualization.
```json
{
  "id": "s1", "type": "status",
  "data": { "state": "working", "label": "Processing files...", "elapsed": "2m 30s", "detail": "Reading src/main.ts" }
}
```
States: `idle` (gray dot), `thinking` (amber, pulsing), `working` (green, pulsing), `blocked` (yellow), `error` (red). Missing `label` defaults to capitalized state name.

### `log`
Rendered by the LogStream component. Append-only scrolling text with auto-follow.
```json
{
  "id": "lg1", "type": "log",
  "data": {
    "title": "Agent Log",
    "lines": [
      { "text": "[10:30:01] Agent started", "level": "info" },
      { "text": "[10:30:05] Warning: large file", "level": "warn" },
      { "text": "[10:30:10] Error: parse failed", "level": "error" }
    ],
    "maxLines": 500,
    "autoFollow": true
  }
}
```
Line levels: `info` (white), `warn` (yellow), `error` (red), `debug` (gray). Auto-follow scrolls to bottom on new data unless user has scrolled up. Line numbers shown in gutter.

### Other types
Unrecognized types render as a fallback showing the type label and a JSON dump of the data.

## Tiered event dispatch

Canvas events support three dispatch tiers, declared in the event payload:

### Tier 0: Armed tools (existing, direct)
```javascript
bridge.send({ _tool: "write", path: "foo.txt", content: "bar" })
// With reply correlation:
bridge.send({ _tool: "read", _rid: "req1", path: "file.txt" })
```
Synchronous execution, no agent turn. Result delivered via `bridge.messageReceived` with matching `_rid`.

### Tier 1: Scoped orchestrator (new)
```javascript
bridge.send({
  _tier: "orchestrator",
  _scope: "Review this diff and suggest improvements",
  _tools: ["read", "grep", "lsp"],  // optional tool restriction
  context: { diffId: "d1", files: ["src/main.ts"] }
})
```
Spawns a lightweight agent session bound to this canvas window. The orchestrator has restricted tools and a fixed scope. Results appear on the canvas. If the task exceeds scope, the orchestrator can escalate to a full agent.

### Tier 2: Full agent
```javascript
bridge.send({
  _tier: "agent",
  _assignment: "Refactor this module to use the new event bus",
  context: { files: ["src/utils/event-bus.ts"] }
})
```
Routes to the main agent session as a follow-up prompt.

## Meta-interface (--qml mode)

When running `spell --qml`, the shell provides:

### Dashboard panel
Second panel in the shell sidebar. Shows:
- Agent busy/idle/blocked status with animated indicator
- Priority queue depth (P1/P2/P3)
- Active orchestrators with scope
- Active canvas windows
- Session token count

### Dynamic panel management
The agent can add/remove panels at runtime via bridge messages:
```json
{ "type": "add_panel", "id": "custom", "title": "My Panel", "path": "path/to/Panel.qml" }
{ "type": "remove_panel", "id": "custom" }
```

## Fallback

When `isDisplayAvailable()` returns false, render content as markdown in the chat:
- Tables -> markdown tables
- Diffs -> fenced code blocks with `diff` language
- Trees -> indented lists
- Prompts -> numbered lists with "reply with the number" instruction

## WM close handling

When the user closes the canvas window via the window manager, a synthetic close event is emitted with `{ wmClose: true }`. Treat this as the user dismissing the canvas — clean up and continue in text mode.
