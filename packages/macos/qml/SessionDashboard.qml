import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

ApplicationWindow {
    id: root
    visible: true
    width: windowWidth
    height: windowHeight
    title: windowTitle
    flags: Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool
    color: "#1e1e2e"

    property var sessions: bridge.props.sessions || []
    property string overviewHotkeyLabel: bridge.props.overviewHotkeyLabel || "Cmd+Opt+O"

    function statusColor(status) {
        var colors = {
            idle: "#a6e3a1",
            running: "#89b4fa",
            needs_input: "#f9e2af",
            error: "#f38ba8",
            completed: "#a6e3a1",
            pending_approval: "#94e2d5",
            user_paused: "#cba6f7"
        }
        return colors[status] || "#6c7086"
    }

    function statusText(status) {
        var labels = {
            idle: "Idle",
            running: "Running",
            needs_input: "Needs Input",
            error: "Error",
            completed: "Completed",
            pending_approval: "Pending Approval",
            user_paused: "Paused"
        }
        return labels[status] || status
    }

    onActiveChanged: {
        if (!active) root.close()
    }

    Shortcut {
        sequence: "Escape"
        onActivated: root.close()
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.action === "update_sessions") {
                root.sessions = payload.sessions
                root.overviewHotkeyLabel = payload.overviewHotkeyLabel || root.overviewHotkeyLabel
            } else if (payload.action === "close") {
                root.close()
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            Text {
                text: "Spell Sessions"
                font.pixelSize: 16
                font.bold: true
                color: "#cdd6f4"
            }
            Item { Layout.fillWidth: true }
            Text {
                text: root.sessions.length === 1 ? "1 active" : root.sessions.length + " active"
                font.pixelSize: 12
                color: "#6c7086"
            }
        }

        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: "#313244"
        }

        ListView {
            id: sessionList
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: root.sessions
            clip: true
            spacing: 4

            delegate: Rectangle {
                required property var modelData
                width: sessionList.width
                height: 56
                radius: 8
                color: mouseArea.containsMouse ? "#313244" : "#181825"

                MouseArea {
                    id: mouseArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        bridge.send({ action: "focus_session", pid: modelData.pid })
                    }
                }

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 10

                    Rectangle {
                        width: 10
                        height: 10
                        radius: 5
                        color: statusColor(modelData.status)
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2

                        Text {
                            text: modelData.projectName || "Unknown"
                            font.pixelSize: 14
                            font.bold: true
                            color: "#cdd6f4"
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }

                        Text {
                            text: modelData.sessionTitle || "Untitled Session"
                            font.pixelSize: 11
                            color: "#a6adc8"
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                    }

                    Rectangle {
                        implicitWidth: statusLabel.implicitWidth + 12
                        implicitHeight: statusLabel.implicitHeight + 4
                        radius: 4
                        color: statusColor(modelData.status)
                        opacity: 0.2

                        Text {
                            id: statusLabel
                            anchors.centerIn: parent
                            text: statusText(modelData.status)
                            font.pixelSize: 10
                            font.bold: true
                            color: statusColor(modelData.status)
                        }
                    }
                }
            }
        }

        Text {
            visible: root.sessions.length === 0
            text: "No active sessions"
            font.pixelSize: 14
            color: "#6c7086"
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: 20
        }

        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: "#313244"
        }

        Text {
            text: "Overview: " + root.overviewHotkeyLabel
            font.pixelSize: 11
            color: "#585b70"
            Layout.alignment: Qt.AlignHCenter
        }
    }
}
