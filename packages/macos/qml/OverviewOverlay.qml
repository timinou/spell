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
    color: "#E0181825"

    property var sessions: bridge.props.sessions || []

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

    Shortcut {
        sequence: "Escape"
        onActivated: root.close()
    }

    onActiveChanged: {
        if (!active) root.close()
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.action === "update_sessions") {
                root.sessions = payload.sessions
            } else if (payload.action === "close") {
                root.close()
            }
        }
    }

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - 80, 980)
        height: Math.min(parent.height - 80, 720)
        radius: 20
        color: "#1e1e2e"
        border.width: 1
        border.color: "#313244"
        opacity: 0.97

        Behavior on opacity {
            NumberAnimation {
                duration: 140
            }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 24
            spacing: 16

            RowLayout {
                Layout.fillWidth: true
                Text {
                    text: "Spell Overview"
                    font.pixelSize: 24
                    font.bold: true
                    color: "#cdd6f4"
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: root.sessions.length === 1 ? "1 session" : root.sessions.length + " sessions"
                    font.pixelSize: 12
                    color: "#a6adc8"
                }
            }

            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: "#313244"
            }

            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true

                Column {
                    width: parent.width
                    spacing: 12

                    Repeater {
                        model: root.sessions
                        delegate: Rectangle {
                            required property var modelData
                            width: parent.width
                            radius: 16
                            color: "#181825"
                            border.width: 1
                            border.color: "#313244"
                            implicitHeight: cardColumn.implicitHeight + 24

                            ColumnLayout {
                                id: cardColumn
                                anchors.fill: parent
                                anchors.margins: 16
                                spacing: 12

                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: 12

                                    Rectangle {
                                        radius: 10
                                        color: statusColor(modelData.status)
                                        implicitWidth: badgeText.implicitWidth + 18
                                        implicitHeight: badgeText.implicitHeight + 10

                                        Text {
                                            id: badgeText
                                            anchors.centerIn: parent
                                            text: statusText(modelData.status)
                                            color: "#11111b"
                                            font.pixelSize: 12
                                            font.bold: true
                                        }
                                    }

                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 2
                                        Text {
                                            text: modelData.projectName || "Unknown Project"
                                            color: "#cdd6f4"
                                            font.pixelSize: 18
                                            font.bold: true
                                            elide: Text.ElideRight
                                            Layout.fillWidth: true
                                        }
                                        Text {
                                            text: modelData.sessionTitle || "Untitled Session"
                                            color: "#a6adc8"
                                            font.pixelSize: 13
                                            elide: Text.ElideRight
                                            Layout.fillWidth: true
                                        }
                                    }
                                }

                                Text {
                                    text: "PID " + modelData.pid + " · Window " + modelData.windowId
                                    color: "#6c7086"
                                    font.pixelSize: 12
                                }
                            }
                        }
                    }

                    Text {
                        visible: root.sessions.length === 0
                        text: "No active sessions"
                        color: "#6c7086"
                        font.pixelSize: 16
                        anchors.horizontalCenter: parent.horizontalCenter
                    }
                }
            }

            Text {
                Layout.alignment: Qt.AlignHCenter
                text: "Press Escape or click away to dismiss"
                color: "#6c7086"
                font.pixelSize: 11
            }
        }
    }
}
