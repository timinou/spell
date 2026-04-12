Launch Qt 6 QML desktop windows for rich structured interactions.

<actions>
- `write`: write a `.qml` file to disk; prefer `canvas://session/<path>` for ephemeral files
- `launch`: spawn a QML window from a file path; optional `title`, `width`, `height`, `props`
- `send_message`: send JSON to a running window
- `close`: close a window by id
- `list_windows`: list tracked windows
- `screenshot`: capture a window PNG; use this for visual verification when layout matters
</actions>

<qml-bridge-api>
Every QML file has `bridge` as a context property: `bridge.props`, `bridge.messageReceived(payload)`, `bridge.send(payload)`.

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
QML files can declare root-level `spellArmedTools`; launch-time `props._armedTools` overrides file-declared tools, file-declared tools are denylisted from arming `bash`, `python`, and `task`, and the safe default is no armed tools.

Tool invocation from QML: `bridge.send({ _tool: "write", path: "/tmp/out.txt", content: "hello" })`; use `_rid` when you need a reply.
</armed-tools>

<workflow>
1. Write the QML file
2. Launch it; the event loop starts automatically
3. Handle follow-up events, send replies, spawn tasks, generate images, etc.
4. Close when done or stop on a close event
</workflow>

<note>
Build the bridge first: `cd packages/qml && bun run build:bridge`.
</note>
