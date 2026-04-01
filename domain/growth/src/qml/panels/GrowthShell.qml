import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

ApplicationWindow {
    id: root
    visible: true
    width: windowWidth
    height: windowHeight
    title: windowTitle
    color: "#111827"

    property var workspaces: bridge.props.workspaces || []
    property var panels: bridge.props.panels || []
    property string currentWorkspaceId: "general"
    property var currentPanels: []
    // Panel registry: maps panelId -> absolute QML file path.
    // Built once from bridge.props.panels in Component.onCompleted.
    property var panelRegistry: ({})

    function iconFor(name: string): string {
        var icons = {
            "home": "\u{1F3E0}",
            "search": "\u{1F50D}",
            "lightbulb": "\u{1F4A1}",
            "edit": "\u{270F}\u{FE0F}",
            "chart": "\u{1F4CA}",
            "rocket": "\u{1F680}",
            "briefcase": "\u{1F4BC}",
            "kanban": "\u{1F4CB}"
        };
        return icons[name] || name || "\u{25CF}";
    }

    // Resolve the main panel for the current workspace and load it.
    function loadWorkspacePanel(): void {
        var ws = null;
        for (var i = 0; i < workspaces.length; i++) {
            if (workspaces[i].id === currentWorkspaceId) {
                ws = workspaces[i];
                break;
            }
        }
        if (!ws || !ws.panels) {
            mainPanelLoader.source = "";
            return;
        }

        for (var j = 0; j < ws.panels.length; j++) {
            if (ws.panels[j].position === "main") {
                var panelPath = panelRegistry[ws.panels[j].panelId];
                if (panelPath) {
                    mainPanelLoader.source = panelPath;
                    return;
                }
            }
        }
        // No main panel mapped — clear loader
        mainPanelLoader.source = "";
    }

    onCurrentWorkspaceIdChanged: loadWorkspacePanel()

    Component.onCompleted: {
        var reg = {};
        for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            if (p.id && p.path) {
                reg[p.id] = p.path;
            }
        }
        panelRegistry = reg;
        loadWorkspacePanel();
    }

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
                                text: root.iconFor(modelData.icon)
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

            // Panel area — Loader resolves the QML file via panelRegistry
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: "#111827"

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
                // TS may override layout — re-resolve panels
                loadWorkspacePanel()
            }
        }
    }
}
