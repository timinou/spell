import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

// The shell IS the ApplicationWindow — this harness IS GrowthShell with test data.
ApplicationWindow {
    id: root
    visible: true
    width: 1280
    height: 900
    title: "Growth Shell Test"
    color: "#111827"

    property var workspaces: [
        { id: "general", name: "General", icon: "home", panels: [{ panelId: "chat", position: "main" }] },
        { id: "research", name: "Research", icon: "search", panels: [{ panelId: "intel", position: "main" }, { panelId: "chat", position: "secondary" }] },
        { id: "strategy", name: "Strategy", icon: "lightbulb", panels: [{ panelId: "dashboard", position: "main" }, { panelId: "chat", position: "secondary" }] },
        { id: "create", name: "Create", icon: "edit", panels: [{ panelId: "editor", position: "main" }, { panelId: "chat", position: "secondary" }] },
        { id: "review", name: "Review", icon: "chart", panels: [{ panelId: "dashboard", position: "main" }, { panelId: "editor", position: "secondary" }] },
        { id: "campaign", name: "Campaign", icon: "rocket", panels: [{ panelId: "planner", position: "main" }, { panelId: "chat", position: "secondary" }] }
    ]
    property string currentWorkspaceId: "general"

    RowLayout {
        anchors.fill: parent
        spacing: 0

        // Workspace sidebar (280px)
        Rectangle {
            Layout.preferredWidth: 280
            Layout.fillHeight: true
            color: "#1F2937"

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 8

                Label {
                    text: "Spell Growth"
                    font.pixelSize: 18
                    font.bold: true
                    color: "#F9FAFB"
                    Layout.fillWidth: true
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: "#374151" }

                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    model: workspaces
                    spacing: 4
                    delegate: Rectangle {
                        required property var modelData
                        required property int index
                        width: ListView.view ? ListView.view.width : 0
                        height: 44
                        radius: 8
                        color: modelData.id === currentWorkspaceId ? "#7C3AED" : "transparent"

                        Label {
                            anchors.fill: parent
                            anchors.margins: 8
                            text: modelData.name
                            font.pixelSize: 14
                            color: modelData.id === currentWorkspaceId ? "white" : "#D1D5DB"
                            verticalAlignment: Text.AlignVCenter
                        }

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                currentWorkspaceId = modelData.id
                                if (typeof bridge !== 'undefined') {
                                    bridge.send({ type: 'workspace_switch', workspaceId: modelData.id })
                                }
                            }
                        }
                    }
                }
            }
        }

        // Main content area
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: "#111827"
                Text {
                    anchors.centerIn: parent
                    text: "Select a workspace to begin"
                    color: "#6B7280"
                    font.pixelSize: 16
                }
            }

            // Chat drawer collapsed bar
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 56
                color: "#1F2937"

                Label {
                    anchors.centerIn: parent
                    text: "Chat"
                    color: "#9CA3AF"
                    font.pixelSize: 12
                }
            }
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload: var): void {
            if (payload.type === 'reset') {
                currentWorkspaceId = "general"
                bridge.send({ type: 'reset_done' })
            }
        }
    }
}
