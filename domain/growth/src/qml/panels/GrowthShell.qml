import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

ApplicationWindow {
    visible: true
    width: windowWidth
    height: windowHeight
    title: windowTitle
    color: "#111827"

    property var workspaces: bridge.props.workspaces || []
    property string currentWorkspaceId: "general"
    property var currentPanels: []

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

                // Header
                Label {
                    text: "Spell Growth"
                    font.pixelSize: 18
                    font.bold: true
                    color: "#F9FAFB"
                    Layout.fillWidth: true
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: "#374151" }

                // Loading indicator when no workspaces
                BusyIndicator {
                    visible: workspaces.length === 0
                    running: workspaces.length === 0
                    Layout.alignment: Qt.AlignHCenter
                }

                // Workspace list
                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    visible: workspaces.length > 0
                    model: workspaces
                    spacing: 4
                    clip: true
                    delegate: Rectangle {
                        width: ListView.view.width
                        height: 44
                        radius: 8
                        color: modelData.id === currentWorkspaceId ? "#7C3AED" : "transparent"

                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: 8
                            spacing: 8

                            Label {
                                text: modelData.icon || ""
                                font.pixelSize: 16
                                color: modelData.id === currentWorkspaceId ? "white" : "#9CA3AF"
                            }
                            Label {
                                text: modelData.name
                                font.pixelSize: 14
                                color: modelData.id === currentWorkspaceId ? "white" : "#D1D5DB"
                                Layout.fillWidth: true
                            }
                        }

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                currentWorkspaceId = modelData.id
                                bridge.send({ type: 'workspace_switch', workspaceId: modelData.id })
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

            // Panel area (panels loaded dynamically based on workspace)
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: "#111827"

                // Placeholder for dynamic panel loading
                Loader {
                    id: mainPanelLoader
                    anchors.fill: parent
                }

                Text {
                    visible: !mainPanelLoader.item
                    anchors.centerIn: parent
                    text: "Select a workspace to begin"
                    color: "#6B7280"
                    font.pixelSize: 16
                }
            }

            // Chat drawer (bottom), clamped to half the window height when expanded
            ChatDrawer {
                Layout.fillWidth: true
                expandedHeight: Math.min(400, Math.floor(parent.height * 0.5))
            }
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === 'workspace_layout') {
                currentPanels = payload.panels
            }
        }
    }
}
