Launch Qt 6 QML desktop windows for rich domain-specific UI interactions.

<actions>
- `write`: Write a `.qml` file to disk (path + content). Use absolute paths under `/tmp/omp-qml/`. Returns confirmation.
- `launch`: Spawn a QML window from a file path. Optional: `title`, `width`, `height`, `props` (JSON object passed as `bridge.props` in QML). Returns window state and any events queued before return.
- `listen`: Block until the window emits one or more events (push-based, no polling, 10-min timeout). Returns all events received. Re-call immediately after handling to keep the listener alive.
- `send_message`: Send a JSON payload to a running window (`bridge.messageReceived` signal fires in QML). Does not wait for events — use `listen` for that.
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
3. **Immediately** call `listen` — do not yield to the user first.
4. Handle each event batch (generate images, send replies via `send_message`, etc.)
5. Re-call `listen` immediately after handling — there must always be a listener in flight.
6. Stop looping when `listen` returns a `close` event or the window state is `closed`.
</workflow>

<note>
Bridge binary must be built first: `cd packages/qml && bun run build:bridge`. If the binary is missing, the tool will report the build command.
</note>