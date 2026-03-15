import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

ApplicationWindow {
    id: root
    visible: true
    width: windowWidth > 0 ? windowWidth : 520
    height: windowHeight > 0 ? windowHeight : 400
    title: "Voice Agent"
    color: "#1a1a1a"

    property var spellArmedTools: ["read"]

    // ── State ────────────────────────────────────────────────────────────────
    property string voiceStatus: "listening"
    property string transcript: ""
    property string partial: ""
    property string command: ""
    property int commandId: -1
    property int lastCommandId: -1
    property double lastUpdate: 0
    property string pipelineError: ""
    // Updated each poll tick so the stale check re-evaluates even when lastUpdate stops changing
    property bool pipelineStale: false

    // Devices list populated from bridge.props.devices at launch
    // Each entry: { name: string, label: string }
    property var devices: []

    // ── Poll timer ───────────────────────────────────────────────────────────

    property string pendingRid: ""

    Timer {
        id: pollTimer
        interval: 400
        running: true
        repeat: true
        onTriggered: {
            // Recompute staleness every tick (lastUpdate stops updating when pipeline dies)
            if (root.lastUpdate > 0 && (Date.now() - root.lastUpdate) > 3000) {
                root.pipelineStale = true
            } else {
                root.pipelineStale = false
            }
            if (root.pendingRid !== "") return
            var rid = "poll-" + Date.now()
            root.pendingRid = rid
            bridge.send({ _tool: "read", _rid: rid, path: "/tmp/spell-voice-state.json" })
        }
    }

    // ── Bridge ────────────────────────────────────────────────────────────────

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            // Initial props injection
            if (payload.type === "init" && payload.props) {
                if (payload.props.devices) root.devices = payload.props.devices
                return
            }

            // Poll reply
            if (payload._rid !== undefined && payload._rid === root.pendingRid) {
                root.pendingRid = ""
                if (payload.error) return
                var text = payload.content !== undefined ? payload.content : payload.text
                if (!text) return
                try {
                    var s = JSON.parse(text)
                    root.voiceStatus   = s.status || "listening"
                    root.transcript    = s.transcript || ""
                    root.partial       = s.partial || ""
                    root.command       = s.command || ""
                    root.commandId     = s.commandId !== undefined ? s.commandId : -1
                    root.lastUpdate    = s.lastUpdate !== undefined ? s.lastUpdate : root.lastUpdate
                    root.pipelineError = s.error || ""

                    if (root.voiceStatus === "command_detected"
                            && root.commandId !== root.lastCommandId
                            && root.command !== "") {
                        root.lastCommandId = root.commandId
                        bridge.send({ type: "voice_command", text: root.command })
                    }
                } catch(e) {}
            }
        }
    }

    // Populate devices from bridge.props on startup
    Component.onCompleted: {
        var props = bridge.props
        if (props && props.devices) {
            root.devices = props.devices
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 12

        // ── Header ────────────────────────────────────────────────────────────
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Rectangle {
                width: 10; height: 10; radius: 5
                color: root.pipelineStale                              ? "#f44336"
                     : root.voiceStatus === "listening"                ? "#4caf50"
                     : root.voiceStatus === "accumulating"             ? "#ff9800"
                     : root.voiceStatus === "command_detected"         ? "#2196f3"
                     : "#888"

                SequentialAnimation on opacity {
                    running: root.voiceStatus !== "command_detected" && !root.pipelineStale
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.3; duration: 600 }
                    NumberAnimation { to: 1.0; duration: 600 }
                }
            }

            Text {
                text: root.pipelineStale                              ? "Pipeline disconnected"
                    : root.voiceStatus === "listening"                ? "Listening..."
                    : root.voiceStatus === "accumulating"             ? "Accumulating command..."
                    : root.voiceStatus === "command_detected"         ? "Processing..."
                    : "Idle"
                color: root.pipelineStale ? "#f44336" : "#cccccc"
                font.pixelSize: 14
                font.family: "monospace"
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "Stop"
                implicitWidth: 70
                implicitHeight: 30
                background: Rectangle {
                    color: parent.pressed ? "#5a2020" : "#3a1a1a"
                    border.color: "#cc4444"; border.width: 1; radius: 4
                }
                contentItem: Text {
                    text: parent.text; color: "#cc4444"
                    font.pixelSize: 12
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
                onClicked: bridge.send({ type: "voice_stop" })
            }
        }

        // ── Device selector ───────────────────────────────────────────────────
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: root.devices.length > 0

            Text {
                text: "Device:"
                color: "#888888"
                font.pixelSize: 12
                font.family: "monospace"
            }

            ComboBox {
                id: deviceCombo
                Layout.fillWidth: true
                model: {
                    var items = [{ name: "default", label: "default" }]
                    for (var i = 0; i < root.devices.length; i++) items.push(root.devices[i])
                    return items
                }
                textRole: "label"

                background: Rectangle {
                    color: "#252525"
                    border.color: "#444"; border.width: 1; radius: 3
                }
                contentItem: Text {
                    leftPadding: 8
                    text: deviceCombo.displayText
                    color: "#cccccc"
                    font.pixelSize: 12
                    font.family: "monospace"
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
                delegate: ItemDelegate {
                    width: deviceCombo.width
                    contentItem: Text {
                        text: modelData.label
                        color: "#cccccc"
                        font.pixelSize: 12
                        font.family: "monospace"
                        elide: Text.ElideRight
                    }
                    background: Rectangle {
                        color: hovered ? "#333" : "#1e1e1e"
                    }
                }
                popup: Popup {
                    y: deviceCombo.height
                    width: deviceCombo.width
                    padding: 0
                    background: Rectangle { color: "#1e1e1e"; border.color: "#444"; border.width: 1; radius: 3 }
                    contentItem: ListView {
                        clip: true
                        implicitHeight: Math.min(contentHeight, 200)
                        model: deviceCombo.popup.visible ? deviceCombo.delegateModel : null
                        ScrollIndicator.vertical: ScrollIndicator {}
                    }
                }

                onActivated: {
                    var selected = model[currentIndex]
                    if (selected) bridge.send({ type: "voice_device", device: selected.name })
                }
            }
        }

        // ── Pipeline error / stale warning ────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            visible: root.pipelineStale || root.pipelineError !== ""
            height: errText.implicitHeight + 12
            color: "#2a0a0a"; border.color: "#f44336"; border.width: 1; radius: 4

            Text {
                id: errText
                anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: 8 }
                text: root.pipelineStale ? "Pipeline disconnected" : root.pipelineError
                color: "#ef9a9a"
                font.pixelSize: 12; font.family: "monospace"
                wrapMode: Text.WordWrap
            }
        }

        // ── Divider ───────────────────────────────────────────────────────────
        Rectangle { Layout.fillWidth: true; height: 1; color: "#333" }

        // ── Transcript ────────────────────────────────────────────────────────
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            Text {
                width: parent.width
                wrapMode: Text.WordWrap
                font.pixelSize: 14
                font.family: "monospace"
                lineHeight: 1.4
                text: root.transcript + (root.partial ? " " + root.partial : "")
                color: "#dddddd"
            }
        }

        // ── Partial text ──────────────────────────────────────────────────────
        Text {
            Layout.fillWidth: true
            visible: root.partial !== ""
            text: root.partial
            color: "#666666"
            font.pixelSize: 12; font.family: "monospace"; font.italic: true
            wrapMode: Text.WordWrap
            elide: Text.ElideRight
            maximumLineCount: 2
        }

        // ── Command preview ───────────────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            visible: root.voiceStatus === "command_detected" && root.command !== ""
            height: cmdText.implicitHeight + 16
            color: "#0d2137"; border.color: "#2196f3"; border.width: 1; radius: 4

            Text {
                id: cmdText
                anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: 8 }
                text: "Command: " + root.command
                color: "#90caf9"
                font.pixelSize: 13; font.family: "monospace"
                wrapMode: Text.WordWrap
            }
        }
    }
}
