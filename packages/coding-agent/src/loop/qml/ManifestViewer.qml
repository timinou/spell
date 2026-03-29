import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.3

ApplicationWindow {
    visible: true
    width: windowWidth
    height: windowHeight
    title: windowTitle
    color: "#1e1e2e"

    property var tickets: bridge.props.tickets || []
    property var progress: bridge.props.progress || {}
    property var edges: bridge.props.dependencyEdges || []
    property string loopName: bridge.props.loopName || ""

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.action === "update") {
                tickets = payload.tickets || tickets
                progress = payload.progress || progress
                edges = payload.dependencyEdges || edges
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        // Header
        Text {
            text: "Manifest: " + loopName
            color: "#cdd6f4"
            font.pixelSize: 18
            font.bold: true
        }

        // Progress bar
        RowLayout {
            spacing: 8
            Layout.fillWidth: true

            Rectangle {
                Layout.fillWidth: true
                height: 24
                radius: 4
                color: "#313244"

                Rectangle {
                    width: parent.width * (progress.total > 0 ? progress.done / progress.total : 0)
                    height: parent.height
                    radius: 4
                    color: "#a6e3a1"
                }
            }

            Text {
                text: (progress.done || 0) + "/" + (progress.total || 0) + " done"
                color: "#a6adc8"
                font.pixelSize: 13
            }
        }

        // Stats row
        RowLayout {
            spacing: 16
            Repeater {
                model: [
                    { label: "Active", count: progress.doing || 0, c: "#89b4fa" },
                    { label: "Blocked", count: progress.blocked || 0, c: "#f38ba8" },
                    { label: "Remaining", count: progress.remaining || 0, c: "#a6adc8" }
                ]
                delegate: Text {
                    required property var modelData
                    text: modelData.label + ": " + modelData.count
                    color: modelData.c
                    font.pixelSize: 13
                }
            }
        }

        // Ticket table
        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: tickets
            spacing: 2

            header: Rectangle {
                width: ListView.view ? ListView.view.width : 0
                height: 32
                color: "#313244"
                radius: 4

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 4
                    spacing: 8
                    Text { text: "ID"; color: "#cdd6f4"; font.bold: true; Layout.preferredWidth: 180 }
                    Text { text: "Title"; color: "#cdd6f4"; font.bold: true; Layout.fillWidth: true }
                    Text { text: "State"; color: "#cdd6f4"; font.bold: true; Layout.preferredWidth: 80 }
                    Text { text: "Priority"; color: "#cdd6f4"; font.bold: true; Layout.preferredWidth: 60 }
                    Text { text: "Effort"; color: "#cdd6f4"; font.bold: true; Layout.preferredWidth: 60 }
                    Text { text: "Gates"; color: "#cdd6f4"; font.bold: true; Layout.preferredWidth: 50 }
                }
            }

            // Empty state
            Text {
                anchors.centerIn: parent
                text: "No tickets in manifest"
                color: "#585b70"
                font.pixelSize: 14
                visible: tickets.length === 0
            }

            delegate: Rectangle {
                required property var modelData
                required property int index
                width: ListView.view ? ListView.view.width : 0
                height: 36
                radius: 4
                color: index % 2 === 0 ? "#181825" : "#1e1e2e"

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 4
                    spacing: 8
                    Text {
                        text: modelData.id || ""
                        color: "#89dceb"
                        font.pixelSize: 12
                        Layout.preferredWidth: 180
                        elide: Text.ElideRight
                    }
                    Text {
                        text: modelData.title || ""
                        color: "#cdd6f4"
                        font.pixelSize: 12
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                    }
                    Rectangle {
                        Layout.preferredWidth: 80
                        Layout.preferredHeight: 24
                        radius: 3
                        color: {
                            var s = modelData.state || ""
                            if (s === "DONE") return "#a6e3a1"
                            if (s === "DOING") return "#89b4fa"
                            if (s === "BLOCKED") return "#f38ba8"
                            if (s === "HOLD") return "#fab387"
                            return "#585b70"
                        }
                        Text {
                            anchors.centerIn: parent
                            text: modelData.state || "ITEM"
                            color: "#1e1e2e"
                            font.pixelSize: 11
                            font.bold: true
                        }
                    }
                    Text {
                        text: modelData.priority || "-"
                        color: "#f9e2af"
                        font.pixelSize: 12
                        Layout.preferredWidth: 60
                        horizontalAlignment: Text.AlignHCenter
                    }
                    Text {
                        text: modelData.effort || "-"
                        color: "#a6adc8"
                        font.pixelSize: 12
                        Layout.preferredWidth: 60
                        horizontalAlignment: Text.AlignHCenter
                    }
                    Text {
                        text: modelData.hasGates ? "Y" : "N"
                        color: modelData.hasGates ? "#a6e3a1" : "#585b70"
                        font.pixelSize: 12
                        Layout.preferredWidth: 50
                        horizontalAlignment: Text.AlignHCenter
                    }
                }
            }
        }
    }
}
