BrowserWindow provides agent-driven web navigation, DOM inspection, interaction, and page-side evaluation.

<instruction>
- Launch once, then drive it with `send_message` payloads whose `action` starts with `browser:`
- Default to `browser:observe` to inspect state and collect stable `element_id` values before interaction
- Prefer ARIA/text selectors; use `click_id`/`type_id`/`fill_id` when you already have observed ids
- Wait for dynamic pages before interacting; use `browser:extract_readable` for simplified text; `browser:screenshot` only for visible-viewport capture
</instruction>

<output>
Text for navigation/DOM queries; images for screenshots.
</output>

<browser>
The BrowserWindow is launched from `canvas://stdlib/canvas/BrowserWindow.qml` with an optional `initialUrl`. Default armed tools: `["read", "write", "grep", "find"]`.

Supported actions, abbreviated: `browser:sync`, `browser:goto`, `browser:force_reload`, `browser:evaluate`, `browser:observe`, `browser:click`, `browser:type`, `browser:fill`, `browser:press`, `browser:scroll`, `browser:drag`, `browser:wait_for_selector`, `browser:get_text`, `browser:get_html`, `browser:get_attribute`, `browser:extract_readable`, `browser:screenshot`.

Give async commands a unique `_rid` and match follow-up results by `_rid`.

Examples:
```json
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:observe", "_rid": "obs-1" } }
{ "action": "send_message", "id": "browser-1", "payload": { "action": "browser:click", "_rid": "click-1", "element_id": 12 } }
```
</browser>

<lint>
QML files are automatically linted with `qmllint` after every `write`. Use type-safe QML; `bridge`, `windowWidth`, `windowHeight`, and `windowTitle` are injected at runtime and safe to use.
</lint>