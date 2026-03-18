# AD-4: Canvas-in-Shell Architecture Decision

## Context
The 2D interaction system needs canvas surfaces alongside the agent chat. Two architecture options were evaluated:

- **Option A:** standalone canvas windows
- **Option B:** embedded canvas panels inside `shell.qml`

## Option A — Standalone Windows

### Description
The canvas tool spawns separate OS windows via `QmlBridge.launch()`. The window manager handles placement/layout. Each window keeps its own event loop, armed tool scope, and bridge connection.

### Proof from current system
- Five reference canvases already run this way (`DataDashboard`, `TaskBoard`, `CodeReviewSurface`, `AgentMonitor`, `InteractiveForm`).
- Multiple windows can be launched simultaneously from TUI.
- Events are already handled per-window.
- Armed tools are already scoped per-window.
- Hot-reload already works per-window.

### Pros
- Zero shell refactor required.
- Zero new protocol required.
- Window manager handles layout (tiling WMs provide panel management by default).
- Each window is self-contained.
- Failure isolation: one canvas crash does not take down other canvases.

### Cons
- No integrated in-shell layout.
- User arranges windows manually (partially mitigated by tiling WM workflows).
- No single shell-level dashboard view when using canvas windows (dashboard is a separate surface).

## Option B — Embedded Panels

### Description
`shell.qml` becomes a multi-panel container and canvas content renders inside shell panels.

### Estimated effort
~30-40 hours for:
- message routing changes
- panel lifecycle management
- layout management inside shell
- armed tool scoping per panel

### Pros
- Integrated UI experience.
- Single window surface.
- Shell-level orchestration possible.

### Cons
- Significant implementation complexity.
- Shell evolves into a framework, not just a host.
- Bridge protocol extensions required.
- Layout management becomes a separate project.

## Decision
**Choose Option A — Standalone Windows.**

### Reasoning
- It is the simplest path with proven behavior now.
- It requires no protocol expansion.
- WM-native layout already solves the panel arrangement problem for power users.
- It matches plan risk mitigation: when options are equivalent, prefer standalone windows because it is simpler and already validated.
- The meta-interface dashboard (PROJ-E) will be implemented as a dedicated panel in `shell.qml` (like `ChatPanel`) rather than as a canvas window, preserving separation of concerns.

### Downstream impact by project
- **PROJ-B:** New components remain canvas-only; no shell embedding work.
- **PROJ-C:** `PriorityEventBus` stays window-scoped; no panel-routing layer.
- **PROJ-D:** Orchestrators bind to `windowId`, not `panelId`.
- **PROJ-E:** Dashboard is a shell panel; canvases remain separate windows.
- **PROJ-F:** Integration tests launch and validate separate canvas windows.

## Consequences
- Accept and document canvases as separate OS windows.
- Keep shell focused on chat + dashboard concerns.
- If embedded panels are required later, the Wave 2-3 event bus/orchestrator investments still transfer and can be reused.
