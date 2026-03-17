import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "." as SpellUI

ApplicationWindow {
    id: root
    visible: true
    width: 1280
    height: 800
    title: "Spell"
    color: SpellUI.SpellTheme.background

    property int activePanelIndex: 0
    property var pendingPanelMessages: ({})
    property var panels: normalizePanels(bridge.props.panels)

    function defaultPanels() {
        return [
            { id: "chat", title: "Chat", icon: "●", path: Qt.resolvedUrl("panels/ChatPanel.qml") },
            { id: "dashboard", title: "Dashboard", icon: "■", path: Qt.resolvedUrl("panels/DashboardPanel.qml") }
        ]
    }

    function resolvePanel(panel, fallbackId) {
        var id = panel && panel.id ? panel.id : fallbackId
        var title = panel && panel.title ? panel.title : "Panel"
        var icon = panel && panel.icon ? panel.icon : "●"
        var path = panel && panel.path ? Qt.resolvedUrl(panel.path) : ""
        return { id: id, title: title, icon: icon, path: path }
    }

    function normalizePanels(inputPanels) {
        if (!inputPanels || !Array.isArray(inputPanels) || inputPanels.length === 0) {
            return defaultPanels()
        }
        var normalized = []
        for (var i = 0; i < inputPanels.length; i++) {
            var panel = inputPanels[i]
            normalized.push(resolvePanel(panel, "panel-" + i))
        }
        return normalized
    }

    function findPanelIndexById(panelId) {
        if (!panelId) return -1
        for (var i = 0; i < panels.length; i++) {
            if (panels[i] && panels[i].id === panelId) return i
        }
        return -1
    }

    function activePanelId() {
        var panel = panels[activePanelIndex]
        return panel && panel.id ? panel.id : null
    }

    function forwardToActivePanel(payload) {
        if (panelLoader.item && typeof panelLoader.item.handleMessage === "function") {
            panelLoader.item.handleMessage(payload)
        }
    }

    function flushPendingForActivePanel() {
        var panelId = activePanelId()
        if (!panelId) return
        var pending = pendingPanelMessages[panelId]
        if (!pending) return
        forwardToActivePanel(pending)
        var nextPending = {}
        for (var key in pendingPanelMessages) {
            if (key !== panelId) nextPending[key] = pendingPanelMessages[key]
        }
        pendingPanelMessages = nextPending
    }

    function addOrReplacePanel(payload) {
        if (!payload || !payload.id) return
        var panel = resolvePanel(payload, payload.id)
        var nextPanels = panels.slice()
        var existingIndex = findPanelIndexById(payload.id)
        if (existingIndex >= 0) {
            nextPanels[existingIndex] = panel
        } else {
            nextPanels.push(panel)
        }
        panels = nextPanels
    }

    function removePanelById(panelId) {
        var removeIndex = findPanelIndexById(panelId)
        if (removeIndex < 0 || panels.length <= 1) return
        var nextPanels = []
        for (var i = 0; i < panels.length; i++) {
            if (i !== removeIndex) nextPanels.push(panels[i])
        }
        if (nextPanels.length === 0) return
        panels = nextPanels
        if (activePanelIndex === removeIndex || activePanelIndex >= nextPanels.length) {
            activePanelIndex = 0
        }
    }

    onActivePanelIndexChanged: flushPendingForActivePanel()

    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal

        // Left sidebar
        Rectangle {
            SplitView.preferredWidth: 240
            SplitView.minimumWidth: 240
            SplitView.maximumWidth: 240
            color: SpellUI.SpellTheme.surfaceHigh

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                // Header
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 56
                    color: "transparent"

                    Text {
                        anchors.centerIn: parent
                        text: "Spell"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
                        font.bold: true
                        color: SpellUI.SpellTheme.textPrimary
                    }
                }

                // Panel list
                ListView {
                    id: panelList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    model: root.panels
                    clip: true

                    delegate: Rectangle {
                        width: panelList.width
                        height: 44
                        color: index === root.activePanelIndex
                            ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, SpellUI.SpellTheme.hoverOpacity)
                            : "transparent"
                        radius: SpellUI.SpellTheme.cornerRadiusSmall

                        Row {
                            anchors.fill: parent
                            anchors.leftMargin: SpellUI.SpellTheme.spacingL
                            anchors.rightMargin: SpellUI.SpellTheme.spacingL
                            spacing: SpellUI.SpellTheme.spacingM

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.icon || "●"
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                color: index === root.activePanelIndex
                                    ? SpellUI.SpellTheme.primary
                                    : SpellUI.SpellTheme.textSecondary
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.title || "Panel"
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                color: index === root.activePanelIndex
                                    ? SpellUI.SpellTheme.textPrimary
                                    : SpellUI.SpellTheme.textSecondary
                            }
                        }

                        SpellUI.StateLayer {
                            onClicked: root.activePanelIndex = index
                        }
                    }
                }

                // Footer
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 80
                    color: "transparent"

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingM
                        spacing: SpellUI.SpellTheme.spacingS

                        Text {
                            Layout.fillWidth: true
                            text: bridge.props.model || "No model"
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.textSecondary
                            elide: Text.ElideRight
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 32
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            color: SpellUI.SpellTheme.surfaceHigher

                            Text {
                                anchors.centerIn: parent
                                text: "Restart Agent"
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                color: SpellUI.SpellTheme.textSecondary
                            }

                            SpellUI.StateLayer {
                                onClicked: bridge.send({ type: "restart" })
                            }
                        }
                    }
                }
            }
        }

        // Right main area
        Rectangle {
            SplitView.fillWidth: true
            color: SpellUI.SpellTheme.background

            Loader {
                id: panelLoader
                anchors.fill: parent
                source: {
                    var panel = root.panels[root.activePanelIndex]
                    if (panel && panel.path) return panel.path
                    return Qt.resolvedUrl("panels/ChatPanel.qml")
                }
                onLoaded: root.flushPendingForActivePanel()
            }

            // Error overlay
            Rectangle {
                anchors.fill: parent
                color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.background, 0.9)
                visible: panelLoader.status === Loader.Error

                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: SpellUI.SpellTheme.spacingL

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: "Failed to load panel"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                        color: SpellUI.SpellTheme.error
                    }

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.maximumWidth: 400
                        text: panelLoader.sourceComponent ? "" : (panelLoader.source + "")
                        font.family: SpellUI.SpellTheme.monoFontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        color: SpellUI.SpellTheme.textSecondary
                        wrapMode: Text.WrapAnywhere
                    }

                    Rectangle {
                        Layout.alignment: Qt.AlignHCenter
                        width: 100
                        height: 36
                        radius: SpellUI.SpellTheme.cornerRadius
                        color: SpellUI.SpellTheme.surfaceHigher

                        Text {
                            anchors.centerIn: parent
                            text: "Retry"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            color: SpellUI.SpellTheme.textPrimary
                        }

                        SpellUI.StateLayer {
                            onClicked: {
                                var src = panelLoader.source
                                panelLoader.source = ""
                                panelLoader.source = src
                            }
                        }
                    }
                }
            }

            Connections {
                target: bridge
                function onMessageReceived(payload) {
                    if (!payload || typeof payload !== "object" || !payload.type) {
                        root.forwardToActivePanel(payload)
                        return
                    }

                    if (payload.type === "add_panel") {
                        root.addOrReplacePanel(payload)
                        return
                    }

                    if (payload.type === "remove_panel") {
                        root.removePanelById(payload.id)
                        return
                    }

                    var targetPanelId = payload.panelId
                    if (!targetPanelId && payload.type === "dashboard_update") {
                        targetPanelId = "dashboard"
                    }

                    if (targetPanelId && targetPanelId !== root.activePanelId()) {
                        if (payload.type === "dashboard_update") {
                            var nextPending = {}
                            for (var key in root.pendingPanelMessages) nextPending[key] = root.pendingPanelMessages[key]
                            nextPending[targetPanelId] = payload
                            root.pendingPanelMessages = nextPending
                        }
                        return
                    }

                    root.forwardToActivePanel(payload)
                }
            }
        }
    }
}
