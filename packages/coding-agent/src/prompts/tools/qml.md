Launch Qt 6 QML desktop windows for rich domain-specific UI interactions.

<actions>
- `write`: Write a `.qml` file to disk (path + content). Use absolute paths under `/tmp/omp-qml/`. Returns confirmation.
- `launch`: Spawn a QML window from a file path. Optional: `title`, `width`, `height`, `props` (JSON object passed as `bridge.props` in QML). Events from the window are delivered automatically as follow-up turns — no manual listen loop required.
- `send_message`: Send a JSON payload to a running window (`bridge.messageReceived` signal fires in QML).
- `close`: Close a window by id.
- `list_windows`: List all tracked windows with their state.
- `screenshot`: Capture a window's content as PNG. Requires `id`. Optional `path` sets the save location (default: `/tmp/omp-qml/screenshot-{id}-{timestamp}.png`). Returns the saved image inline.
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