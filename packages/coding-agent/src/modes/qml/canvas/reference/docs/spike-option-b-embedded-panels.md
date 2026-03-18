# Spike: Option B — Embedded Canvas Panels in `shell.qml`

## 1) Overview
Option B means canvas content is no longer rendered in separate top-level windows. Instead, canvas views are hosted as dynamic panels inside `shell.qml`.

This shifts canvas from a window-per-surface model to a multi-panel-in-one-shell model. The user experience is tighter (single workspace), but shell and bridge responsibilities expand substantially.

## 2) Current Shell Architecture
Current shell behavior is optimized for a single active panel:

- `shell.qml` uses a `SplitView` with:
  - fixed 240px sidebar
  - main area driven by a `Loader`
- Sidebar holds panel list + active highlight + model info + restart control.
- Main loader swaps QML file by `activePanelIndex`.
- One bridge connection per window.
- Incoming bridge messages are dispatched to the active panel only (`handleMessage(payload)`).

Implication: current flow assumes one message target at a time and one armed-tool scope per window.

## 3) Required Changes for Embedded Panels

### a) Panel Registration Protocol
Need explicit runtime panel lifecycle messages so the agent can create/remove panels dynamically.

Proposed protocol additions:

- `{"type": "add_panel", "id": "...", "title": "...", "path": "..."}`
- `{"type": "remove_panel", "id": "..."}`

Required implementation effects:

- Shell keeps a dynamic panel registry (id, title, component path, state).
- Sidebar model becomes mutable at runtime (agent-initiated adds/removes).
- Panel IDs become stable routing keys (not just list indices).

### b) Message Routing
Current routing sends all payloads to the active panel.

Required routing model:

- Every panel-targeted payload carries `panelId`.
- Shell dispatcher resolves `payload.panelId` and forwards to the matching panel instance/loader.
- Unknown `panelId` handling (drop + error event) is required to avoid silent loss.
- Architecture must support multiple simultaneously visible panels (e.g., split view / tabbed view), not just hidden inactive loaders.

Core complexity is not rendering; it is robust fan-out/fan-in routing with lifecycle safety.

### c) Armed Tool Scoping
Current armed tools are window-scoped.

For embedded panels, tool authority must be panel-scoped:

- Canvas tool tracks `panelId -> armedTools` mapping.
- Tool invocation event extraction includes panel context.
- Permission checks happen against panel scope before invoking tools.
- Prevents privilege bleed where one panel can invoke tools armed for another.

This is a protocol + security boundary change, not just UI wiring.

### d) Event Loop Changes
Current runtime operates effectively as one event loop per window.

Embedded panels require event demultiplexing:

- Bridge emits events with panel context.
- Canvas runtime demuxes events by `panelId`.
- Per-panel channels/handlers process interaction events independently.
- Debounce/dedup logic must avoid cross-panel interference.

Without this, concurrent panel interactions will race or misroute.

### e) Layout Management
A multi-panel shell needs user-managed layout primitives:

- resize handles between panels
- reorder behavior
- panel close controls
- possible nested splits or tab groups

Even with existing `SplitView`, production-grade panel UX (persistence, minimum sizes, focus behavior, drag-reorder, close semantics) is a significant standalone QML effort.

## 4) Complexity Assessment (~30–40h)

| Change Area | Scope | Estimate |
|---|---|---:|
| Panel registration protocol (`add_panel`/`remove_panel`) | Bridge message schema, shell registry, dynamic sidebar model updates | 5–7h |
| Message routing by `panelId` | Dispatcher refactor, unknown-target handling, panel instance addressing | 7–9h |
| Armed tool scoping per panel | Runtime data model change, tool invoke path updates, permission checks | 6–8h |
| Event loop demuxing | Event envelope changes, per-panel channels, dedup/debounce correctness | 5–7h |
| Layout management UX | Split/tab behavior, controls, resizing/reordering/close flow | 8–10h |

**Total: 31–41h** (practically ~30–40h depending on layout ambition and regression hardening).

## 5) Risks

1. **Shell complexity growth**: `shell.qml` becomes a mini panel framework with lifecycle, routing, and layout orchestration responsibilities.
2. **Protocol blast radius**: bridge message contract changes touch all canvas consumers and event/tool pipelines.
3. **Layout project creep**: panel UX expectations (resize/reorder/persistence/focus) can expand beyond initial scope.
4. **Isolation/security regressions**: per-panel armed-tool boundaries are easy to get subtly wrong.
5. **State correctness issues**: panel add/remove while messages are in flight can produce stale-target races.

## 6) Conclusion
Option B gives tighter shell integration and a unified workspace, but the cost is substantial. The dominant complexity is in panel lifecycle and message/event/tool routing correctness, not in canvas block rendering itself.

If pursued, treat this as a shell/bridge architecture project rather than a simple canvas embedding task.