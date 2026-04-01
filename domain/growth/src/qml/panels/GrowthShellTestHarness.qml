import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// The shell IS the ApplicationWindow — this harness IS GrowthShell with test data.
ApplicationWindow {
    id: root
    visible: true
    width: 1280
    height: 900
    title: "Growth Shell Test"
    color: "#111827"

    property var workspaces: bridge.props.workspaces || [
        { id: "general", name: "General", icon: "home", panels: [{ panelId: "chat", position: "main" }] },
        { id: "research", name: "Research", icon: "search", panels: [{ panelId: "intel", position: "main", flex: 2 }, { panelId: "chat", position: "secondary", flex: 1 }] },
        { id: "strategy", name: "Strategy", icon: "lightbulb", panels: [{ panelId: "dashboard", position: "main", flex: 2 }, { panelId: "chat", position: "secondary", flex: 1 }] },
        { id: "create", name: "Create", icon: "edit", panels: [{ panelId: "editor", position: "main", flex: 2 }, { panelId: "chat", position: "secondary", flex: 1 }] },
        { id: "review", name: "Review", icon: "chart", panels: [{ panelId: "dashboard", position: "main" }, { panelId: "editor", position: "secondary" }] },
        { id: "campaign", name: "Campaign", icon: "rocket", panels: [{ panelId: "planner", position: "main", flex: 2 }, { panelId: "chat", position: "secondary", flex: 1 }] }
    ]
    property var panels: bridge.props.panels || []
    property string currentWorkspaceId: "general"
    property var panelRegistry: ({})

    // Flex ratios for the SplitView — updated by loadWorkspacePanels().
    property int mainFlex: 1
    property int secondaryFlex: 1

    // Constant icon map — avoids allocating per call.
    readonly property var iconMap: ({
        "home": "\u{1F3E0}",
        "search": "\u{1F50D}",
        "lightbulb": "\u{1F4A1}",
        "edit": "\u{270F}\u{FE0F}",
        "chart": "\u{1F4CA}",
        "rocket": "\u{1F680}",
        "briefcase": "\u{1F4BC}",
        "kanban": "\u{1F4CB}"
    })

    function iconFor(name: string): string {
        return iconMap[name] || name || "\u{25CF}";
    }

    function loadWorkspacePanels(): void {
        var ws = null;
        for (var i = 0; i < workspaces.length; i++) {
            if (workspaces[i].id === currentWorkspaceId) {
                ws = workspaces[i];
                break;
            }
        }
        if (!ws || !ws.panels) {
            mainPanelLoader.source = "";
            secondaryPanelLoader.source = "";
            mainFlex = 1;
            secondaryFlex = 1;
            return;
        }

        var newMainSource = "";
        var newSecondarySource = "";
        var newMainFlex = 1;
        var newSecondaryFlex = 1;

        for (var j = 0; j < ws.panels.length; j++) {
            var panel = ws.panels[j];
            var panelPath = panelRegistry[panel.panelId] || "";
            if (panel.position === "main" && panelPath) {
                newMainSource = panelPath;
                newMainFlex = panel.flex || 1;
            } else if (panel.position === "secondary" && panelPath) {
                newSecondarySource = panelPath;
                newSecondaryFlex = panel.flex || 1;
            }
        }

        mainPanelLoader.source = newMainSource;
        secondaryPanelLoader.source = newSecondarySource;
        mainFlex = newMainFlex;
        secondaryFlex = newSecondaryFlex;
    }

    function forwardToPanel(loader: var, payload: var): void {
        if (loader.item && typeof loader.item.handleMessage === "function") {
            loader.item.handleMessage(payload)
        }
    }

    onCurrentWorkspaceIdChanged: loadWorkspacePanels()

    Component.onCompleted: {
        var reg = {};
        for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            if (p.id && p.path) {
                reg[p.id] = p.path;
            }
        }
        panelRegistry = reg;
        loadWorkspacePanels();
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
                                verticalAlignment: Text.AlignVCenter
                            }
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

        // Main content area — vertical SplitView with main + secondary panels
        SplitView {
            orientation: Qt.Vertical
            Layout.fillWidth: true
            Layout.fillHeight: true

            // Main panel
            Rectangle {
                SplitView.fillHeight: true
                SplitView.preferredHeight: secondaryPanelLoader.source != ""
                    ? root.height * mainFlex / (mainFlex + secondaryFlex)
                    : root.height
                color: "#111827"

                Loader {
                    id: mainPanelLoader
                    objectName: "mainPanelLoader"
                    anchors.fill: parent
                }

                Text {
                    visible: !mainPanelLoader.item && mainPanelLoader.status !== Loader.Error
                    anchors.centerIn: parent
                    text: "Select a workspace to begin"
                    color: "#6B7280"
                    font.pixelSize: 16
                }

                Rectangle {
                    anchors.fill: parent
                    color: Qt.rgba(0.067, 0.094, 0.153, 0.9)
                    visible: mainPanelLoader.status === Loader.Error

                    Text {
                        anchors.centerIn: parent
                        text: "Failed to load panel"
                        color: "#EF4444"
                        font.pixelSize: 16
                    }
                }
            }

            // Secondary panel
            Rectangle {
                visible: secondaryPanelLoader.source != ""
                SplitView.preferredHeight: root.height * secondaryFlex / (mainFlex + secondaryFlex)
                color: "#111827"

                Loader {
                    id: secondaryPanelLoader
                    objectName: "secondaryPanelLoader"
                    anchors.fill: parent
                }

                Rectangle {
                    anchors.fill: parent
                    color: Qt.rgba(0.067, 0.094, 0.153, 0.9)
                    visible: secondaryPanelLoader.status === Loader.Error

                    Text {
                        anchors.centerIn: parent
                        text: "Failed to load panel"
                        color: "#EF4444"
                        font.pixelSize: 16
                    }
                }
            }
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload: var): void {
            if (payload.type === 'reset') {
                currentWorkspaceId = "general"
                mainFlex = 1
                secondaryFlex = 1
                loadWorkspacePanels()
                bridge.send({ type: 'reset_done' })
            } else if (payload.type === 'workspace_layout') {
                loadWorkspacePanels()
            } else if (payload.type === 'switch_workspace' && payload.workspaceId) {
                currentWorkspaceId = payload.workspaceId
            }
            // Forward all messages to both panels — each handles what it understands.
            forwardToPanel(mainPanelLoader, payload)
            forwardToPanel(secondaryPanelLoader, payload)
        }
    }
}
