# Canvas

The canvas is a persistent QML window the agent spawns to display structured content — tables, diffs, trees, prompts — during conversations.

## Running it

### Prerequisites

Build the QML bridge binary (one-time):

```bash
cd packages/qml && bun run build:bridge
```

Verify it works:

```bash
bun -e "const { isBridgeAvailable } = require('@oh-my-pi/pi-qml'); console.log('bridge:', isBridgeAvailable())"
```

### From a spell session

The agent spawns the canvas automatically when it decides visual output would help (comparisons, large tables, diffs, tree views). The activation rule triggers on:

- Structured comparisons with >3 options
- Tabular data with >5 rows
- Diffs longer than 50 lines
- Hierarchical data
- Multi-step decisions with tradeoffs

No manual intervention needed — the agent writes a launcher QML, spawns it, and populates it via the message protocol.

### Manual / development use

Write a launcher QML that wraps Canvas.qml:

```qml
import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    visible: true
    width: 900; height: 600
    title: "My Canvas"

    Canvas {
        id: canvas
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            canvas.handleMessage(payload)
        }
    }
}
```

Then from the agent (or a test):

```
qml write  path="canvas-launcher.qml"  content="<the QML above>"
qml launch id="canvas-demo" path="canvas-launcher.qml"
qml send_message id="canvas-demo" payload={
  "action": "set",
  "content": [
    {"id": "t1", "type": "table", "data": {
      "columns": [{"key": "name", "label": "Name"}, {"key": "score", "label": "Score"}],
      "rows": [{"name": "Alice", "score": 95}, {"name": "Bob", "score": 87}]
    }}
  ]
}
```

### Running the tests

Unit tests (no display needed):

```bash
bun test packages/qml/test/display-detection.test.ts
bun test packages/coding-agent/test/tools/qml-event-classification.test.ts
bun test packages/coding-agent/test/tools/qml-event-deduplication.test.ts
```

Integration tests (need bridge binary; skip cleanly without it):

```bash
bun test packages/coding-agent/test/modes/qml-canvas-runtime.test.ts
bun test packages/coding-agent/test/modes/qml-canvas-data-table.test.ts
bun test packages/coding-agent/test/modes/qml-canvas-diff-view.test.ts
bun test packages/coding-agent/test/modes/qml-canvas-tree-view.test.ts
bun test packages/coding-agent/test/modes/qml-canvas-structured-input.test.ts
bun test packages/coding-agent/test/tools/qml-wm-close.test.ts
```

Or all canvas tests at once:

```bash
bun test packages/coding-agent/test/modes/qml-canvas*.test.ts packages/coding-agent/test/tools/qml-event*.test.ts packages/coding-agent/test/tools/qml-wm*.test.ts packages/qml/test/display-detection.test.ts
```

## Message protocol

| Action | Direction | Purpose |
|--------|-----------|---------|
| `set` | agent->canvas | Replace all content blocks |
| `append` | agent->canvas | Add blocks to existing content |
| `remove` | agent->canvas | Remove a block by id |
| `sync` | agent->canvas | Request full state dump |
| `state` | canvas->agent | State dump response |
| `prompt` | agent->canvas | Present a choice/input |
| `respond` | canvas->agent | User's answer to a prompt |

## Components

| Type | Data shape |
|------|-----------|
| `table` | `{columns: [{key, label, width?}], rows: [{...}], sortable?, highlightRow?}` |
| `diff` | `{filename?, hunks: [{header, lines: [{type, text}]}]}` |
| `tree` | `{nodes: [{id, label, icon?, expanded?, children?}]}` |
| `markdown` | `{text: "..."}` |
| `image` | `{url: "..." or src: "..."}` |
| unknown | Renders fallback with type name + JSON preview |

## File layout

```
packages/coding-agent/src/modes/qml/canvas/
  Canvas.qml                 -- core runtime (Item, not ApplicationWindow)
  ContentBlock.qml           -- polymorphic block renderer
  CanvasTestHarness.qml      -- test harness
  components/
    DataTable.qml             -- sortable table
    DataTableTestHarness.qml
    DiffView.qml              -- unified diff viewer
    DiffViewTestHarness.qml
    TreeView.qml              -- collapsible tree
    TreeViewTestHarness.qml

packages/coding-agent/src/tools/
  qml.ts                     -- QmlTool (WM-close surfacing, canvas debouncing)
  qml-event-utils.ts         -- extracted classifyEvent, deduplicateEvents

packages/qml/src/
  qml-bridge.ts              -- isDisplayAvailable()

.spell/skills/canvas/SKILL.md       -- agent skill documentation
.spell/rules/canvas-activation.md   -- activation rule
```
