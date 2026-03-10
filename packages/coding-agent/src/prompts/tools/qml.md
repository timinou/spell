Launch Qt 6 QML desktop windows for rich domain-specific UI interactions.

<actions>
- `write`: Write a `.qml` file to disk (path + content). Use absolute paths under `/tmp/omp-qml/`. Returns confirmation.
- `launch`: Spawn a QML window from a file path. Optional: `title`, `width`, `height`, `props` (JSON object passed as `bridge.props` in QML). Returns window state and any pending events.
- `send_message`: Send a JSON payload to a running window (`bridge.messageReceived` signal fires in QML). Set `wait_for_event: true` to block until the window emits an event back.
- `close`: Close a window by id.
- `list_windows`: List all tracked windows with their state.
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
2. `launch` with the file path
3. User interacts with the window; poll events via `send_message` or `list_windows`
4. `close` when done
</workflow>

<note>
Bridge binary must be built first: `cd packages/qml && bun run build:bridge`. If the binary is missing, the tool will report the build command.
</note>
