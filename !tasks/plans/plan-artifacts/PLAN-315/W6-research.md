# W6 — /memory TUI browser implementation plan

## 1. Current TUI architecture (with file:line refs)

### Mode system
All modes live in `packages/coding-agent/src/modes/`. Two run-mode types:

- **InteractiveMode** (`modes/interactive-mode.ts`) — the primary TUI mode. Implements `InteractiveModeContext` (`modes/types.ts:1-200`). Constructor at line ~300 wires controllers: `#commandController` (line 286), `#selectorController` (line 288), `#inputController` (line 289). Exported from `modes/index.ts:12`.
- **BrowseMode** (`modes/browse-mode.ts`) — QML browser shell, separate TUI. Not relevant.
- **FluidMode** (`modes/fluid-mode.ts`) — headless loop-driven mode. Not relevant.
- **PrintMode** (`modes/print-mode.ts`) — non-interactive output. Not relevant.

A mode's **Context** interface (`modes/types.ts`) is the hub: all controller access, all UI state, all lifecycle methods flow through it. Our panel will live entirely inside InteractiveMode's lifecycle.

### Panel composition
There is no formal abstract "Panel" base class. Instead, panels are **Components** from `@oh-my-pi/pi-tui` that implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}
```

(Verified by reading `SubagentViewerComponent` at `modes/components/subagent-viewer/viewer-component.ts:47-49` which `implements Component` with these exact methods.)

Panels are **mounted** via `SelectorController.showSelector()` (`modes/controllers/selector-controller.ts:86-97`):
1. Creates a `done()` callback that clears `editorContainer` and restores focus to the editor
2. Clears `editorContainer.children` and adds the panel component
3. Calls `ui.setFocus(panel)`
4. Panel `handleInput()` receives key events; when user selects/closes, `done()` restores editor

The current `editorContainer` children pattern is:
- Normal: `[editor]`
- Panel active: `[panelComponent]`

### Slash command registry
Defined in `modes/slash-commands/builtin-registry.ts`. Every command is a `BuiltinSlashCommandSpec` entry in `BUILTIN_SLASH_COMMAND_REGISTRY` (line 70). Each has: `name`, `description`, optional `subcommands[]`, optional `allowArgs`, and a `handle()` async callback receiving `{name, args, text}` + a `BuiltinSlashCommandRuntime` containing the `InteractiveModeContext`.

Registration flow:
1. `src/extensibility/slash-commands.ts` exports `BUILTIN_SLASH_COMMANDS` (line ~125), built from `BUILTIN_SLASH_COMMAND_DEFS` enriched with autocomplete and inline-hint helpers.
2. `InteractiveMode` constructor at line ~408 collects `pendingSlashCommands` from builtins + hook commands + custom commands + skill commands.
3. `input-controller.ts:206` calls `executeBuiltinSlashCommand(text, runtime)` to dispatch.
4. `modes/interactive-mode.ts:703-717` (`refreshSlashCommandState`) also merges file-based + mode-derived commands.

`/memory` already exists as a builtin (builtin-registry.ts:~620-640) with subcommands: `view`, `clear`, `reset`, `enqueue`, `rebuild`. Its handler delegates to `ctx.handleMemoryCommand(text)` which routes through `CommandController.handleMemoryCommand()` (`command-controller.ts:555-580`).

### Keybind routing
`CustomEditor` (`modes/components/custom-editor.ts`) extends `Editor` from `@oh-my-pi/pi-tui`. It intercepts raw terminal data via `handleInput(data)` (line 54), uses `matchesKey(data, "ctrl+<key>")` to detect specific key combos, and fires registered callbacks.

Registering a new keybind requires two sites:
1. **CustomEditor**: add `onCtrlX?: () => void` property + `if (matchesKey(data, "ctrl+x") && this.onCtrlX)` handler in `#handleInputInner`
2. **InputController** (`modes/controllers/input-controller.ts`): wire the editor callback in the constructor (lines 78-101)

Current bindings that matter as precedent:
| Key | Handler | Wire site |
|-----|---------|-----------|
| Ctrl-T | `toggleTodoExpansion()` | custom-editor.ts:98-100 → input-controller.ts:89 |
| Ctrl-R | `showHistorySearch()` | custom-editor.ts:110-112 → input-controller.ts:88 |
| Ctrl-L | `showModelSelector()` | custom-editor.ts:104-106 → input-controller.ts:87 |

### Subscribe-style live data sources
**No precedent exists.** Everything is either:
- **Pull-based** (memory tool calls `executeOrg` which makes a synchronous native call)
- **EventBus-based** (SubagentViewerComponent subscribes to `EventBus` channels — see `modes/components/subagent-viewer/viewer-component.ts:90`, subscribes to `TASK_SUBAGENT_EVENT_CHANNEL` and `TASK_SUBAGENT_PROGRESS_CHANNEL`)
- **Session-based** (session events via `session.subscribe()`, used by `BrowseMode` at `browse-mode.ts:41-50`)

No panel today receives WebSocket-style push updates from a daemon. The `KnowledgeSubscription` at `crates/pi-natives/src/knowledge_client.rs` is a Rust-only construct (see Section 3).

---

## 2. Memory tool surface (TS, today)

The `MemoryTool` class lives at `packages/coding-agent/src/tools/memory.ts`. It implements `AgentTool<typeof memorySchema, MemoryDetails, Theme>` (line ~170). Actions are dispatched through `dispatchMemoryAction()` (line ~290).

### Endpoints we'll call

| Action | Function | Key params | Return shape |
|--------|----------|------------|-------------|
| `search` | `dispatchMemoryAction(action:"search", text, scope?, focus?, hops?, limit?, includePersonal?, profile?)` | min: `text` | `{hits: [{id, score, title, kind, …}]}` |
| `about` | `dispatchMemoryAction(action:"about", id/focus)` | min: `id` | `{node:{id,kind?,title?}, neighbors:[{id,kind,via}], lineage:[id]}` |
| `neighbors` | `dispatchMemoryAction(action:"neighbors", focus/id, hops?, kinds?)` | min: `focus` | `{nodes:[{id,title,kind}], edges:[{from,to,kind}]}` |
| `since` | `dispatchMemoryAction(action:"since", ts)` | min: `ts` | `{added:[], modified:[], deleted:[], ts, note}` |

### How they're called today
All actions go through `executeOrg()` from `@oh-my-pi/pi-natives` → `crates/pi-natives/src/org_buffer.rs:1431` (`#[napi(js_name = "executeOrg")]`). This is a synchronous N-API call that bridges to the Rust org engine (in-process, not daemon-routed for these operations).

For the panel, we'll need to re-export these action functions from the tool module or call `executeOrg` directly with the correct JSON command shape. The `formatMemoryResult()` helper (memory.ts:~550) provides compact line-oriented formatting we can reuse for display.

### Existing return shapes (from memory.ts):
- `search` → list of hit objects with `id`, `score` (float), `title` (optional)
- `about` → triple: `{node, neighbors[], lineage[]}` where neighbor has `id`, `kind` (edge kind), `via` ("in"|"out")
- `neighbors` → `{nodes[], edges[]}` — full subgraph
- `since` → `{added[], modified[], deleted[], ts, note}` — file-level entries with `id`, `file`, `mtime`

---

## 3. Subscribe bridge gap analysis

### Is KnowledgeSubscription exposed via napi?
**No.** The struct is defined in `crates/pi-natives/src/knowledge_client.rs:55` and publicly exported as `pub mod knowledge_client` in `crates/pi-natives/src/lib.rs:91`. However, there is **no `#[napi]` annotation** anywhere on the struct or its methods. A grep for `#[napi]` in `crates/pi-natives/src/knowledge_client.rs` and `crates/pi-natives/src/code_path/napi.rs` yields no results. The only napi function is `executeOrg` in `org_buffer.rs:1431`.

The struct requires a `UnixStream` (Unix domain socket) constructor and a background thread — both are non-trivial to bridge through napi-rs because napi-rs doesn't directly support async callbacks from Rust threads into JS without the Node.js event loop.

### Minimum delta to expose via napi
We would need to:
1. Add `#[napi]` to `KnowledgeSubscription` struct and its `subscribe()` method
2. Export a JS-callable constructor that takes a callback (napi-rs ThreadsafeFunction)
3. Handle the background thread → JS callback bridge (napi-rs `AsyncWork` or `ThreadsafeFunction<T>`)
4. Re-export from `@oh-my-pi/pi-natives`

**Added complexity**: napi-rs ownership/lifetime management for the callback, thread-safety of the bridge, and testing.

**Estimated effort**: ~120-180 LOC in Rust + a new napi export entry point.

### Alternative: Poll every N seconds
**Tradeoffs:**

| Factor | Polling | Subscribe |
|--------|---------|-----------|
| Complexity | ~20 LOC in TS | ~180 LOC Rust + napi bridge |
| Latency | Up to N seconds | Near-real-time |
| CPU | Marginal (stat/dir walk) | Marginal (socket read) |
| Persistence | Works offline | Requires daemon |
| Reliability | Falls through to WarmEngine | Falls if daemon down |
| Testability | Pure TS, easy | Integration test needed |

**Recommendation**: Start with polling (2s interval, cancel on dispose). The `since` action is already an fs.stat-based poll (memory.ts:440-510). The search/about/neighbors actions are synchronous `executeOrg` calls. A subscriber sidecar can be added later when latency matters.

**Bridge to daemon events**: Even the subscribe route would need translation — the daemon emits raw org-mutation events, not "memory-item-changed" events. The `since` endpoint already provides the time-windowed diff the panel needs; polling `since` every 2s would give us the same data with <2s staleness.

---

## 4. Proposed panel design (4 tabs)

### Search tab
```
┌─ Memory Browser ─────────────────────────────────────┐
│  [Search]  Graph  Recent  Since                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │ > <query input>                                  │ │
│  │                                                  │ │
│  │  1. CON-42  (0.923) "Memory tool surface"        │ │
│  │  2. EP-17   (0.845) "W6 research session"        │ │     ← j/k navigation
│  │  3. CON-9   (0.621) "Panel architecture"         │ │
│  │  4. DEC-3   (0.511) "Use poll over subscribe"    │ │
│  │                                                  │ │
│  │  [Preview area for selected hit]                 │ │
│  │  node: CON-42                                    │ │
│  │  neighbors: 5  │  lineage: CON-9, DEC-3         │ │
│  └──────────────────────────────────────────────────┘ │
│  ↑/↓: navigate  Enter: open  Tab: switch tab  Esc:   │
└──────────────────────────────────────────────────────┘
```

- Input field at top for query text
- Results list below, auto-executes on Enter or after 300ms debounce
- j/k or ↑/↓ navigates hits
- Enter on a hit: switch to Graph tab focused on that node
- Right-side preview from `about` result

### Graph tab
```
┌─ Memory Browser ─────────────────────────────────────┐
│  Search  [Graph]  Recent  Since                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Focus: CON-42 "Memory tool surface"             │ │
│  │                                                  │ │
│  │           DEC-3───────┐                          │ │
│  │           (use poll)  │                          │ │
│  │                ▲      │                          │ │
│  │          DISTILLED    │ INVOLVED                 │ │
│  │                │      ▼                          │ │
│  │    CON-9 ←───────── CON-42 ────────→ EP-17      │ │
│  │  (architecture)     (focus)        (research)    │ │
│  │                          │                       │ │
│  │                     DISTILLED                    │ │
│  │                          ▼                       │ │
│  │                     PB-12                        │ │
│  │                 (W6 playbook)                    │ │
│  │                                                  │ │
│  │  [Tab] focus: EP-17  [Space] refocus  [j/k] nav │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- Shows focused node ID + title
- Lists 1-hop neighbors with edge kind labels (color-coded by direction: in vs out)
- Lineage chain (DISTILLED_FROM / SUPERSEDES) compacted below node
- Tab cycles focus to next neighbor, Space re-fetches neighbors for that node
- Enter opens the focused node (`about` detail in preview strip)

### Recent tab
```
┌─ Memory Browser ─────────────────────────────────────┐
│  Search  Graph  [Recent]  Since                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Episodes (mtime desc)                           │ │
│  │  ─────────────────────                            │ │
│  │  2026-05-22 14:30  EP-92 "W6 research"           │ │
│  │  2026-05-22 11:15  EP-91 "Fix memory clear"      │ │
│  │  2026-05-21 23:45  EP-90 "Plan-315 sync"         │ │
│  │  ...                                              │ │
│  │                                                  │ │
│  │  [j/k nav · Enter shows about for that episode]  │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- Lists `.org` files under `.spell/memory/episodes/` sorted by mtime desc
- Shows: date/time, CUSTOM_ID, title (first heading line)
- Also shows other memory kinds mixed in (concepts, playbooks, decisions) with kind icon
- j/k navigation, Enter → `about` on selected item

### Since tab
```
┌─ Memory Browser ─────────────────────────────────────┐
│  Search  Graph  Recent  [Since]                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Since: ● Last 24h  ○ Last 7d                    │ │
│  │                                                  │ │
│  │  Added (2):                                      │ │
│  │    CON-43 "Graph navigation architecture"         │ │
│  │    EP-93  "Daily sync"                           │ │
│  │  Modified (5):                                   │ │
│  │    CON-9  "Panel architecture"                    │ │
│  │    DEC-3  "Use poll over subscribe"              │ │
│  │    ...                                            │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- Toggle: Last 24h / Last 7d
- Calls `since()` with the appropriate timestamp
- Sections: Added / Modified / Deleted (filtered by kind icons)
- j/k nav, Enter → `about`

### Keyboard legend (all tabs)
| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Enter` | Open selected item (switch to Graph + focus on node) |
| `Tab` / `Shift+Tab` | Cycle tabs left/right |
| `Esc` | Close panel, restore editor |
| `g` | Go to top |
| `G` (Shift+g) | Go to bottom |

---

## 5. File-by-file implementation outline

### New files

#### F1: `packages/coding-agent/src/modes/components/memory-browser/index.ts`
**Purpose**: Barrel re-export.
**Content**: `export * from "./browser-component";`
**LOC**: 2
**Depends-on**: F2

#### F2: `packages/coding-agent/src/modes/components/memory-browser/browser-component.ts`
**Purpose**: Main panel component — tab container + event routing.
**New exports**: `class MemoryBrowserComponent implements Component`
**LOC**: ~120
**Dependencies**: F3, F4, F5, F6
**Key methods**:
- `constructor(options: MemoryBrowserOptions)` — initialize 4 tabs, start poll interval
- `render(width) string[]` — delegate to active tab
- `handleInput(data)` — keyboard routing (j/k/Enter/Tab/Esc)
- `invalidate()` — propagate
- `dispose()` — cancel poll interval, tear down subscriptions
- `#switchTab(index)` — swap active tab
- `#setFocus(nodeId)` — navigate to Graph tab focused on node

#### F3: `packages/coding-agent/src/modes/components/memory-browser/search-tab.ts`
**Purpose**: Search tab — input field + results list + preview pane.
**New exports**: `class MemorySearchTab` (or exported from tab barrel)
**LOC**: ~100
**Depends-on**: F7 (memory actions)

#### F4: `packages/coding-agent/src/modes/components/memory-browser/graph-tab.ts`
**Purpose**: Graph tab — focused node, neighbors list, edge-kind indicators, lineage.
**New exports**: `class MemoryGraphTab`
**LOC**: ~90
**Depends-on**: F7 (memory actions)

#### F5: `packages/coding-agent/src/modes/components/memory-browser/recent-tab.ts`
**Purpose**: Recent episodes tab — mtime-sorted list.
**New exports**: `class MemoryRecentTab`
**LOC**: ~60
**Depends-on**: F7 (memory actions) — calls `since()` with far-past ts or dir scan

#### F6: `packages/coding-agent/src/modes/components/memory-browser/since-tab.ts`
**Purpose**: Time-windowed diff tab — 24h/7d toggle.
**New exports**: `class MemorySinceTab`
**LOC**: ~70
**Depends-on**: F7 (memory actions)

#### F7: `packages/coding-agent/src/modes/components/memory-browser/actions.ts`
**Purpose**: Re-exportable memory action wrappers for the panel. Thin wrappers around `dispatchMemoryAction()` from `memory.ts` that the panel can call without importing the full `MemoryTool` class.
**New exports**: 
- `async function memorySearch(params)`
- `async function memoryAbout(id)`
- `async function memoryNeighbors(focus, opts?)`
- `async function memorySince(ts)`
**LOC**: ~35
**Depends-on**: `memory.ts` (existing)

#### F8: `packages/coding-agent/src/modes/components/memory-browser/types.ts`
**Purpose**: Shared types for the browser.
**New exports**: `MemoryBrowserTab enum` (Search | Graph | Recent | Since), `MemoryBrowserTabState` (selectedIndex, activeTab, pollActive, scrollOffset per tab), `MemoryBrowserOptions`
**LOC**: ~30
**Depends-on**: none

### Modified files

#### M1: `packages/coding-agent/src/modes/components/custom-editor.ts`
**Change**: Add `onCtrlM?: () => void` property (line ~19, after `onCtrlT`) + handler in `#handleInputInner` (after `ctrl+t` block at line ~100).
**LOC delta**: +4

#### M2: `packages/coding-agent/src/modes/controllers/input-controller.ts`
**Change**: Wire `this.ctx.editor.onCtrlM = () => this.ctx.showMemoryBrowser()` (after line ~89).
**LOC delta**: +1

#### M3: `packages/coding-agent/src/modes/controllers/selector-controller.ts`
**Change**: Implement `showMemoryBrowser()` body — currently referenced from `interactive-mode.ts:2128` but selector-controller has no implementation (verified: grep for `showMemoryBrowser` in selector-controller.ts returned no results). 
**Implementation**:
```typescript
showMemoryBrowser(): void {
  this.showSelector(done => {
    const browser = new MemoryBrowserComponent({
      cwd: getProjectDir(),
      onClose: () => {
        browser.dispose();
        done();
        this.ctx.ui.requestRender();
      },
      onRequestRender: () => this.ctx.ui.requestRender(),
    });
    return { component: browser, focus: browser };
  });
}
```
**Imports needed**: `MemoryBrowserComponent` from `../components/memory-browser`, `getProjectDir` from `@oh-my-pi/pi-utils`
**LOC delta**: ~20

#### M4: `packages/coding-agent/src/modes/interactive-mode.ts`
**Change**: Import `MemoryBrowserComponent` not needed here directly (it's in selector-controller). However, `showMemoryBrowser()` in interactive-mode.ts (line 2127-2128) already delegates to `this.#selectorController.showMemoryBrowser()` — **no change needed here** if M3 is implemented.

#### M5: `packages/coding-agent/src/modes/utils/hotkeys-markdown.ts`
**Change**: Add `Ctrl+M` entry to the hotkeys table (after `Ctrl+T`, line ~49-50).
**LOC delta**: +2

### NOT modified
- `modes/types.ts` — `showMemoryBrowser()` is already declared in `InteractiveModeContext` (line 197)
- `slash-commands/builtin-registry.ts` — `/memory` already exists; the browser is a Ctrl-M panel, not a new slash command. The existing `/memory` commands (view/clear/enqueue) remain orthogonal.
- `memory.ts` — the tool surface is consumed through new thin wrappers in F7

### Total LOC estimate
| File | LOC |
|------|-----|
| F1 index.ts | 2 |
| F2 browser-component.ts | 120 |
| F3 search-tab.ts | 100 |
| F4 graph-tab.ts | 90 |
| F5 recent-tab.ts | 60 |
| F6 since-tab.ts | 70 |
| F7 actions.ts | 35 |
| F8 types.ts | 30 |
| M1 custom-editor.ts | +4 |
| M2 input-controller.ts | +1 |
| M3 selector-controller.ts | +20 |
| M5 hotkeys-markdown.ts | +2 |
| **Total** | **~534** |

---

## 6. Slash command + keybind

### `/memory` command — already exists
Currently at `packages/coding-agent/src/slash-commands/builtin-registry.ts:~620-640`. Has subcommands: `view`, `clear`, `reset`, `enqueue`, `rebuild`. Its handler calls `ctx.handleMemoryCommand(text)`.

**Decision**: Leave `/memory` as-is (it operates on memory maintenance, not the browser). The browser is a panel, not a slash command. If desired, a future `/browse memory` subcommand could open the panel, but Ctrl-M is the primary entry point.

### Ctrl-M binding — exact sites
**Site 1 — CustomEditor property**: `packages/coding-agent/src/modes/components/custom-editor.ts:17` (after `onCtrlT` on line 17). Add:
```typescript
onCtrlM?: () => void;
```

**Site 2 — CustomEditor handler**: `packages/coding-agent/src/modes/components/custom-editor.ts:97-101` (after the `ctrl+t` handler block at ~line 97-101). Add:
```typescript
// Intercept Ctrl+M for memory browser
if (matchesKey(data, "ctrl+m") && this.onCtrlM) {
  this.onCtrlM();
  return;
}
```

**Site 3 — InputController wiring**: `packages/coding-agent/src/modes/controllers/input-controller.ts:89-90` (after `this.ctx.editor.onCtrlT` on line 89). Add:
```typescript
this.ctx.editor.onCtrlM = () => this.ctx.showMemoryBrowser();
```

**Precedent**: Ctrl-T (`toggleTodoExpansion`) follows exactly this pattern:
- Property declaration at `custom-editor.ts:17`
- Handled at `custom-editor.ts:98-100`
- Wired at `input-controller.ts:89`

### Tab navigation within the panel
All handled internally by `MemoryBrowserComponent.handleInput()`:
- `ctrl+tab` / `shift+tab` for tab switch (same pattern as SubagentViewer at viewer-component.ts:138-143)

---

## 7. Subagent dispatch breakdown

### Task 1: Panel core + types (F1, F2, F8)
**filesDeps**: `packages/coding-agent/src/modes/components/memory-browser/`
**Assignment**:
- Create `types.ts` — `MemoryBrowserTab` enum, `MemoryBrowserTabState`, `MemoryBrowserOptions`
- Create `index.ts` — barrel re-export
- Create `browser-component.ts` — `MemoryBrowserComponent implements Component`
  - Tab management (4 tabs, switch via handleInput)
  - Keyboard routing (j/k/Enter/Tab/Esc)
  - 2s poll interval for "Since" tab (start in constructor, cancel in dispose)
  - Delegates `render()` to active tab, pads with spacer lines
  - Preview strip at bottom for selected item metadata
  - `handleInput` routes to active tab's handler first, then intercepts Tab/Esc at container level
- Acceptance: panel renders empty chrome, Tab cycles between four placeholders

### Task 2: Tab implementations (F3, F4, F5, F6, F7)
**filesDeps**: `packages/coding-agent/src/modes/components/memory-browser/`
**Assignment**:
- Create `actions.ts` — thin wrappers calling `dispatchMemoryAction` from `memory.ts`
  - `memorySearch(text, opts?)` → `dispatchMemoryAction({action:"search", text, ...opts}, repoRoot)`
  - `memoryAbout(id)` → `dispatchMemoryAction({action:"about", id}, repoRoot)`
  - `memoryNeighbors(focus, opts?)` → `dispatchMemoryAction({action:"neighbors", focus, ...opts}, repoRoot)`
  - `memorySince(ts)` → `dispatchMemoryAction({action:"since", ts}, repoRoot)`
- Create `search-tab.ts` — `MemorySearchTab { render(), handleInput(), setQuery(), getSelectedNodeId() }`
  - Input line at top for query
  - Results list with j/k nav
  - Debounced search (300ms after last keystroke)
  - Preview pane from `memoryAbout()` for selected hit
- Create `graph-tab.ts` — `MemoryGraphTab { render(), handleInput(), setFocusNodeId() }`
  - Focus node display (id + title + kind)
  - Neighbors list with edge kind labels, via direction
  - Lineage list
  - Tab cycles focus, Space re-fetches
- Create `recent-tab.ts` — `MemoryRecentTab { render(), handleInput() }`
  - Lists episodes from `memorySince()` with far-past ts
  - j/k nav, Enter fires callback
- Create `since-tab.ts` — `MemorySinceTab { render(), handleInput() }`
  - 24h/7d toggle
  - Shows added/modified sections
- Acceptance: each tab renders meaningful content when memory data exists

### Task 3: Integration points (M1, M2, M3, M5)
**filesDeps**: 
- `packages/coding-agent/src/modes/components/custom-editor.ts`
- `packages/coding-agent/src/modes/controllers/input-controller.ts`
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/src/modes/utils/hotkeys-markdown.ts`

**Assignment**:
- Add `onCtrlM` to `CustomEditor` — property at line ~18, handler after ctrl+t block
- Wire `onCtrlM → showMemoryBrowser()` in `InputController` constructor (after line ~89)
- Implement `showMemoryBrowser()` in `SelectorController` — create `MemoryBrowserComponent`, wrap in `showSelector()`, import needed deps
- Add `Ctrl+M` entry to hotkeys markdown table
- Acceptance: Ctrl-M opens panel, Esc closes it, /memory commands still work independently

### Dependency graph
```
Task 1 (core)     Task 2 (tabs)
       \            /
        \          /
         Task 3 (integration)
              |
         build check
```

Task 1 and Task 2 can be parallelized. Task 3 depends on both (needs the component class and the action wrappers). Gate: `bun check:ts` passes in `packages/coding-agent`.

---

## 8. Risk / open questions

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Poll-based "Since" tab refreshes may overlap with user scrolling | Scrolling jumps | Cache last poll result in tab state; only re-render if user is at top of list or new items > threshold |
| `executeOrg` calls are synchronous — could block render | Frozen terminal during search | Run async wrappers; use `showSelector`'s `done()` lifecycle; show loading indicator |
| Large memory stores (10k+ episodes) could make scan slow | Long poll intervals | Cap `limit` param on search results; `since` already batches per-kind reads |
| No `#[napi]` on `KnowledgeSubscription` — subscribe bridge deferred | Live updates delayed by up to 2s | Poll at 2s is acceptable for first iteration; subscribe can be added in W7 without panel changes if we use an EventBus abstraction |
| Keyboard focus: panel replaces editor, but some key handlers live in editor | Missing Ctrl-T/Ctrl-R while panel is open | Not a problem — `handleInput` on the panel component only receives events when focused; editor handlers are inactive while panel is mounted |
| Workspace lints forbid `unwrap()` | CI rejection | Use `?` propagation or `unwrap_or_default()` everywhere |

### Open questions (need human decision before W7)

1. **Poll interval default**: What value? 2s as recommended? Acceptable range: 1s (snappy but more fs reads) — 5s (gentler).
2. **Tab persistence**: When user closes and re-opens browser, should the previous tab and scroll position be remembered for the session? Or always start on Search? Recommend: always start on Search (simpler, matches user expectation).
3. **Memory row limit** on Search tab: 20 items by default? Configurable? Recommend: 20, same as `formatMemoryResult` (memory.ts:~565).
4. **Preview on Search tab**: Show `about` result as compact text beneath the search list? Or open Graph tab when Enter is pressed? Recommend: show compact preview inline, Enter opens Graph tab. Leave room for both.
5. **Ctrl-M on non-interactive modes**: Should it be a no-op or show a warning? Recommend: no-op (Ctrl-M handler only wired in InteractiveMode).
6. **Graceful degradation when memory is empty**: Show "No memories found" placeholder on all tabs vs. show tab chrome with empty lists? Recommend: show tab chrome with per-tab empty state text.
