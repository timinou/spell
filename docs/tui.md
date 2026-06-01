# TUI integration for extensions and custom tools

This document covers the **current** TUI contract used by `packages/coding-agent` and `packages/tui` for extension UI, custom tool UI, and custom renderers.

## What this subsystem is

The runtime has two layers:

- **Rendering engine (`packages/tui`)**: differential terminal renderer, input dispatch, focus, overlays, cursor placement.
- **Integration layer (`packages/coding-agent`)**: mounts extension/custom-tool components, wires keybindings/theme, and restores editor state.

## Runtime behavior by mode

| Mode | `ctx.ui.custom(...)` availability | Notes |
| --- | --- | --- |
| Interactive TUI | Supported | Component is mounted in the editor area, focused, and must call `done(result)` to resolve. |
| Background/headless | Not interactive | UI context is no-op (`hasUI === false`). |
| RPC mode | Not supported | `custom()` returns `Promise<never>` and does not mount TUI components. |

If your extension/tool can run in non-interactive mode, guard with `ctx.hasUI` / `pi.hasUI`.

## Core component contract (`@spell/pi-tui`)

`packages/tui/src/tui.ts` defines:

```ts
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

`Focusable` is separate:

```ts
export interface Focusable {
  focused: boolean;
}
```

Cursor behavior uses `CURSOR_MARKER` (not `getCursorPosition`). Focused components emit the marker in rendered text; `TUI` extracts it and positions the hardware cursor.

## Rendering constraints (terminal safety)

Your `render(width)` output must be terminal-safe:

1. **Never exceed `width` on any line**. The renderer throws if a non-image line overflows.
2. **Measure visual width**, not string length: use `visibleWidth()`.
3. **Truncate/wrap ANSI-aware text** with `truncateToWidth()` / `wrapTextWithAnsi()`.
4. **Sanitize tabs/content** from external sources using `replaceTabs()` (and higher-level sanitizers in coding-agent render paths).

Minimal pattern:

```ts
import { replaceTabs, truncateToWidth } from "@spell/pi-tui";

render(width: number): string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## Input handling and keybindings

### Raw key matching

Use `matchesKey(data, "...")` for navigation keys and combos.

### Respect user-configured app keybindings

Extension UI factories receive a `KeybindingsManager` (interactive mode) so you can honor mapped actions instead of hardcoding keys:

```ts
if (keybindings.matches(data, "interrupt")) {
  done(undefined);
  return;
}
```

### Key release/repeat events

Key release events are filtered unless your component sets:

```ts
wantsKeyRelease = true;
```

Then use `isKeyRelease()` / `isKeyRepeat()` if needed.

## Focus, overlays, and cursor

- `TUI.setFocus(component)` routes input to that component.
- Overlay APIs exist in `TUI` (`showOverlay`, `OverlayHandle`), but extension `ctx.ui.custom` mounting in interactive mode currently replaces the editor component area directly.
- The `custom(..., options?: { overlay?: boolean })` option exists in extension types; interactive extension mounting currently ignores this option.

## Mount points and return contracts

## 1) Extension UI (`ExtensionUIContext`)

Current signature (`extensibility/extensions/types.ts`):

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: { overlay?: boolean },
): Promise<T>
```

Behavior in interactive mode (`extension-ui-controller.ts`):

- Saves editor text.
- Replaces editor component with your component.
- Focuses your component.
- On `done(result)`: calls `component.dispose?.()`, restores editor + text, focuses editor, resolves promise.

So `done(...)` is mandatory for completion.

## 2) Hook/custom-tool UI context (legacy typing)

`HookUIContext.custom` is typed as `(tui, theme, done)` in hook/custom-tool types.
Underlying interactive implementation calls factories with `(tui, theme, keybindings, done)`. JS consumers can use the extra arg; type-level compatibility still reflects the 3-arg legacy signature.

Custom tools typically use the same UI entrypoint via the factory-scoped `pi.ui` object, then return the selected value in normal tool content:

```ts
async execute(toolCallId, params, onUpdate, ctx, signal) {
  if (!pi.hasUI) {
    return { content: [{ type: "text", text: "UI unavailable" }] };
  }

  const picked = await pi.ui.custom<string | undefined>((tui, theme, done) => {
    const component = new MyPickerComponent(done, signal);
    return component;
  });

  return { content: [{ type: "text", text: picked ? `Picked: ${picked}` : "Cancelled" }] };
}
```


## 3) Custom tool call/result renderers

Custom tools and extension tools can return components from:

- `renderCall(args, theme)`
- `renderResult(result, options, theme, args?)`

`options` currently includes:

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

These renderers are mounted by `ToolExecutionComponent`.

## Lifecycle and cancellation

- `dispose()` is optional at type level but should be implemented when you own timers, subprocesses, watchers, sockets, or overlays.
- `done(...)` should be called exactly once from your component flow.
- For cancellable long-running UI, pair `CancellableLoader` with `AbortSignal` and call `done(...)` from `onAbort`.

Example cancellation pattern:

```ts
const loader = new CancellableLoader(tui, theme.fg("accent"), theme.fg("muted"), "Working...");
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then(result => done(result));
return loader;
```

## Realistic custom component example (extension command)

```ts
import type { Component } from "@spell/pi-tui";
import { SelectList, matchesKey, replaceTabs, truncateToWidth } from "@spell/pi-tui";
import { getSelectListTheme, type ExtensionAPI } from "@spell/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = item => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.list.render(width).map(line => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        const items = [
          { value: "fast", label: theme.fg("accent", "Fast") },
          { value: "balanced", label: "Balanced" },
          { value: "quality", label: "Quality" },
        ];
        return new Picker(items, keybindings, done);
      });

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## Key implementation files

- `packages/tui/src/tui.ts` — `Component`, `Focusable`, cursor marker, focus, overlay, input dispatch.
- `packages/tui/src/utils.ts` — width/truncation/sanitization primitives.
- `packages/tui/src/keys.ts` / `keybindings.ts` — key parsing and configurable action mapping.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — interactive mounting/unmounting for extension/hook/custom-tool UI.
- `packages/coding-agent/src/extensibility/extensions/types.ts` — extension UI and renderer contracts.
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI contract (legacy custom signature).
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — custom tool execute/render contracts.
- `packages/coding-agent/src/modes/components/tool-execution.ts` — mounting `renderCall`/`renderResult` components and partial-state options.
- `packages/coding-agent/src/tools/context.ts` — tool UI context propagation (`hasUI`, `ui`).

## Rendering model & scrollback preservation

The TUI renders **inline** into the terminal's normal screen (no alternate
screen). It keeps a live region at the bottom and lets old content scroll
naturally into the terminal's own scrollback. `#doRender` classifies each frame
into a `RenderIntent` and delegates to a dedicated emitter:

| intent | when | scrollback |
|---|---|---|
| `initial` | first paint after `start()` | viewport cleared, **history kept** |
| `diff` | normal content change / append | grows naturally, history kept |
| `viewportRepaint` | forced reset, width/height change, offscreen edit | in-place repaint, history kept |
| `shrink` | trailing rows dropped | extras cleared inline, history kept |
| `historyRebuild` | width change with offscreen edits | viewport + scrollback cleared so history rewraps |
| `sessionReplace` | explicit `requestRender(true, { clearScrollback: true })` | viewport + scrollback wiped |

**Key rule:** a forced redraw — `requestRender(true)` — does **not** erase
terminal scrollback by default. It repaints the viewport only, so a window
resize, focus change (niri image suppress/restore), or post-init repaint never
destroys the user's history. The destructive `\x1b[3J` (erase-scrollback) is
emitted **only** for `sessionReplace`/`historyRebuild`, and never inside a
multiplexer (`TMUX`/`STY`/`ZELLIJ`). To wipe history on purpose (a true session
replace, e.g. a future `/clear`), pass `requestRender(true, { clearScrollback: true })`.

See `BUG-418` / `PLAN-321` and `packages/tui/test/scrollback-preservation.test.ts`.

### Troubleshooting: terminal jumps to the bottom while a task runs

The TUI no longer wipes history on redraw, but the **terminal emulator's own
"scroll-to-bottom on output" policy** still pulls the viewport down whenever the
live region grows (streaming output) while you have manually scrolled up. This
is emulator behavior, not something the inline renderer can suppress on the
normal screen.

- **Ghostty:** set `scroll-to-bottom = never` (or the value matching your
  version) in `~/.config/ghostty/config` to pause follow-on-output while you are
  scrolled up — the iTerm-style behavior. See
  <https://ghostty.org/docs/config/reference#scroll-to-bottom> and discussion
  [#10456](https://github.com/ghostty-org/ghostty/discussions/10456).
- For reading long task output in-app, use the live task/subagent overlay, which
  owns its own viewport with `j/k` · `PgUp/PgDn` · `g/G` navigation and an
  `autoFollow` toggle.

