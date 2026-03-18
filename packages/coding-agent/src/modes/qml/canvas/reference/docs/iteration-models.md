# Canvas Iteration Models

## Overview
The canvas system supports three iteration models with different tradeoffs: file-watch hot reload, session-scoped file paths, and message-based updates. The first two are full-QML workflows that re-parse files on change; the third updates in-memory canvas state over bridge IPC. Choose based on latency tolerance, layout flexibility, and whether runtime state must be preserved.

## Comparison

| Model | Latency | Expressiveness | State Preservation | Recommended Use |
| --- | --- | --- | --- | --- |
| File Watch + Hot-Reload | ~200-350ms | Full QML (any layout, custom components, animations) | None (full re-parse clears runtime state) | Initial canvas design, complex custom layouts, development iteration |
| Session-Scoped Paths (`canvas://session/`) | ~200-350ms + ~50ms URL resolution overhead | Full QML (same as file watch) | None | Disposable canvases, session-isolated prototyping, path-management convenience |
| Message Protocol (`send_message`) | 1-5ms | Constrained to defined block types (markdown, image, table, diff, tree, prompts) | Full (only affected blocks change) | Dynamic data updates, live dashboards, interactive workflows, production canvases |

## File Watch + Hot-Reload
### How it works
`QmlWatcher` uses native `fs.watch` with a 150ms debounce timer. On change, debounce fires, the bridge sends a `reload` command, and the QML engine re-parses the full file.

### Measured latency
~200-350ms total (150ms debounce + ~50-200ms QML re-parse).

### Expressiveness
Full QML: arbitrary layout composition, custom components, and animations.

### State preservation
None. Full re-parse resets runtime state such as model data and scroll position.

### Best for
Initial canvas design, complex custom layouts, and development-time iteration.

## Session-Scoped Paths (`canvas://session/`)
### How it works
`canvas://session/<path>` resolves to a session-local disk path, then content is written and launched/reloaded through the same file-watch pipeline.

### Measured latency
Same as file watch (~200-350ms) plus ~50ms URL resolution and file-path setup overhead.

### Expressiveness
Full QML, equivalent to file-watch workflows.

### State preservation
None. Reload still re-parses the full QML file.

### Best for
Disposable canvases, session-isolated prototyping, and avoiding manual path management.

## Message Protocol (`send_message`)
### How it works
`send_message` sends JSON over bridge IPC to QML, `bridge.messageReceived` routes through `handleMessage(payload)`, and the model updates in place (`set`, `append`, `remove`, `update`, `sync`, `prompt`).

### Measured latency
1-5ms end-to-end (Unix socket in daemon mode <1ms, stdio mode <5ms).

### Expressiveness
Constrained to predefined AgentCanvas block types: `markdown`, `image`, `table`, `diff`, `tree`, and prompts.

### State preservation
Full. Only targeted blocks update; existing runtime state remains intact.

### Best for
Dynamic data updates, live dashboards, interactive workflows, and production canvases.

## Recommendation
Use the message protocol as the primary iteration model for production canvases. Use file-watch hot reload for initial canvas design and when building complex custom QML components. Session-scoped paths add no runtime advantage beyond path convenience; use them for one-off or disposable canvases where automatic session isolation and cleanup are useful.