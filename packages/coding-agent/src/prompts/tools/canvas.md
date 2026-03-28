Launch Qt 6 QML desktop windows for rich domain-specific UI interactions.

<actions>
- `write`: Write a `.qml` file to disk (path + content). Prefer `canvas://session/<path>` for session-scoped ephemeral files, or use a project path like `.spell/skills/{skill}/foo.qml`. Returns confirmation.
- `launch`: Spawn a QML window from a file path. Optional: `title`, `width`, `height`, `props` (JSON object passed as `bridge.props` in QML). Events from the window are delivered automatically as follow-up turns — no manual listen loop required.
- `send_message`: Send a JSON payload to a running window (`bridge.messageReceived` signal fires in QML).
- `close`: Close a window by id.
- `list_windows`: List all tracked windows with their state.
- `screenshot`: Capture a window's content as PNG. Requires `id`. Optional `path` sets the save location (default: `/tmp/spell-qml/screenshot-{id}-{timestamp}.png`). Returns the saved image inline.
</actions>

<qml-bridge-api>
Every QML file has `bridge` available as a context property:
- `bridge.props` — read-only QJsonObject with initial props from `launch`
- `bridge.messageReceived(payload)` — signal fired when `send_message` is called
- `bridge.send(payload)` — call to emit an event back to the agent

Example minimal QML:
```qml
import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    visible: true
    width: windowWidth
    height: windowHeight
    title: windowTitle

    Button {
        text: "Submit"
        onClicked: bridge.send({ name: "submit", value: field.text })
    }
}
```
</qml-bridge-api>

<armed-tools>
QML files can declare which tools they need via a root-level property:
```qml
ApplicationWindow {
    visible: true
    property var spellArmedTools: ["write", "read", "generate_image"]
    // ...
}
```

When a QML file declares `spellArmedTools`, those tools are automatically armed for the window without needing `props._armedTools` at launch time.

**Merge semantics:**
- Explicit `props._armedTools` at launch overrides file-declared tools
- File-declared tools are filtered through a denylist: `bash`, `python`, `task` cannot be armed from QML declarations
- If neither is present, no tools are armed (safe default)

**Tool invocation protocol** (from QML side):
- `bridge.send({ _tool: "write", path: "/tmp/out.txt", content: "hello" })` — fire-and-forget
- `bridge.send({ _tool: "read", _rid: "req1", path: "file.txt" })` — with reply; result delivered via `bridge.messageReceived` with matching `_rid`
</armed-tools>

<workflow>
1. `write` the QML file
2. `launch` with the file path — the window opens and a background event loop starts automatically
3. Events from the window arrive as follow-up turns (no manual listen calls needed)
4. Handle each event batch: send replies via `send_message`, spawn tasks, generate images, etc.
5. Call `close` when done, or detect a close event in the follow-up and stop handling
</workflow>

<note>
Bridge binary must be built first: `cd packages/qml && bun run build:bridge`. If the binary is missing, the tool will report the build command.
</note>

<browser>
The **BrowserWindow** provides an agent-driven web browser for navigation, DOM inspection, interaction, and page-side evaluation. Launch it once, then drive it with `send_message` payloads whose `action` starts with `browser:`.

**Launch the browser:**

```json
{
  "action": "launch",
  "id": "browser-1",
  "path": "canvas://stdlib/canvas/BrowserWindow.qml",
  "title": "Browser",
  "width": 1280,
  "height": 900,
  "props": {
    "initialUrl": "https://example.com"
  }
}
```

**Browser window props:**
- `initialUrl` — URL to load on startup (default: `about:blank` or the last saved URL)
- `settingsCategory` — settings namespace for saved browser state
- `storageName` — persistent WebEngine storage namespace
- `settingsFile` — optional explicit settings file path
- Default armed tools: `["read", "write", "grep", "find"]`

**Send commands with `send_message`:**

Each command is a JSON payload sent to the running browser window. Use a unique `_rid` when you need a correlated async result.

**Supported actions:**
- `browser:sync` — return the current browser state snapshot
- `browser:goto` (`url`) — navigate to a URL
- `browser:evaluate` (`script`) — evaluate JavaScript in the page world and return the result
- `browser:observe` (`include_all?`, `viewport_only?`, `limit?`) — scan the page and return observed elements with `id` values
- `browser:click` (`selector` or `element_id` or `x`/`y`) — click a target
- `browser:type` (`selector` or `element_id`, `text`) — append text to an editable target
- `browser:fill` (`selector` or `element_id`, `value`) — replace an editable value
- `browser:press` (`key`) — dispatch a key press
- `browser:scroll` (`delta_x`, `delta_y`, optional `selector` or `element_id`) — scroll the page or a target element
- `browser:drag` (`from_selector`/`to_selector`, `from_element_id`/`to_element_id`, or `from_x`/`from_y`/`to_x`/`to_y`) — drag between targets
- `browser:wait_for_selector` (`selector`, optional `timeout_ms`, `visible?`) — wait until a selector appears
- `browser:get_text` (`selector` or `args`) — read element text
- `browser:get_html` (`selector` or `args`) — read element HTML
- `browser:get_attribute` (`selector`, `attribute`, or `args`) — read attribute values
- `browser:extract_readable` (`format: "text" | "markdown"`) — extract simplified readable content
- `browser:screenshot` (`path?`) — save a PNG of the visible viewport only

**Result payloads:**

Commands with `_rid` respond with:

```json
{
  "action": "browser:result",
  "_rid": "req-1",
  "command": "browser:goto",
  "ok": true,
  "result": { ... },
  "error": null,
  "url": "https://example.com",
  "title": "Example",
  "state": "interactive"
}
```

When `ok` is `false`, `error` has `{ code, message, detail }`. For `browser:screenshot`, the success `result` contains the saved `path` plus the current `url` and `title`.

**Background browser events:**
- Silent: `browser:state`, `browser:url_changed`
- Loud: `browser:navigation_blocked`, `browser:navigation_failed`, `browser:console`

**Element targeting:**
- Use `browser:observe` first to get stable `element_id` values for later `click` / `type` / `fill` / `drag` calls
- Selectors may be CSS, `text/...`, `aria/...`, `xpath/...`, or legacy `p-text/...`, `p-aria/...`, `p-xpath/...`, `p-pierce/...` prefixes
- Coordinate clicks use `x`/`y`; coordinate drags use `from_x`/`from_y`/`to_x`/`to_y`

**Example: navigate, observe, click by element id**

```json
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:goto", "_rid": "nav-1", "url": "https://example.com/login" } }
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:observe", "_rid": "obs-1" } }
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:click", "_rid": "click-1", "element_id": 12 } }
```

**Example: fill and submit a form**

```json
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:fill", "_rid": "fill-1", "selector": "input[name='email']", "value": "user@example.com" } }
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:type", "_rid": "type-1", "selector": "input[name='password']", "text": "hunter2" } }
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:click", "_rid": "submit-1", "selector": "button[type='submit']" } }
```

**Async correlation:**
- Give each command a unique `_rid`
- Match follow-up results by `_rid`
- Omit `_rid` only for fire-and-forget actions where you do not need a terminal result
</browser>

<lint>
QML files are automatically linted with `qmllint` after every `write`. Lint results appear in the tool response.

Write type-safe QML:
- Annotate function parameters and return types: `function foo(x: int): string { … }`
- Use `pragma FunctionSignatureBehavior: Enforced` at the top of QML files where strict function typing is needed
- To suppress a false positive inline: `// qmllint disable <check-id>` on the offending line
- The context properties `bridge`, `windowWidth`, `windowHeight`, and `windowTitle` are injected at runtime and are always safe to use — they are not reported as errors
</lint>