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
    // Tracks the active panel's Loader.status reactively so the error overlay
    // can bind to it. Updated by each delegate's onStatusChanged and by
    // onActivePanelIndexChanged.
    property int activePanelLoaderStatus: Loader.Null

    ListModel { id: panelsModel }

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
        for (var i = 0; i < panelsModel.count; i++) {
            if (panelsModel.get(i).id === panelId) return i
        }
        return -1
    }

    function activePanelId() {
        if (activePanelIndex < 0 || activePanelIndex >= panelsModel.count) return null
        return panelsModel.get(activePanelIndex).id
    }

    function getActivePanelItem() {
        var loader = panelRepeater.itemAt(activePanelIndex)
        return loader ? loader.item : null
    }

    function getActivePanelStatus() {
        return activePanelLoaderStatus
    }

    function forwardToActivePanel(payload) {
        var item = getActivePanelItem()
        if (item && typeof item.handleMessage === "function") {
            item.handleMessage(payload)
        }
    }

    function flushPendingForActivePanel() {
        var panelId = activePanelId()
        if (!panelId) return
        var pending = pendingPanelMessages[panelId]
        if (!pending) return
        var item = getActivePanelItem()
        if (!item || typeof item.handleMessage !== "function") return
        item.handleMessage(pending)
        var nextPending = {}
        for (var key in pendingPanelMessages) {
            if (key !== panelId) nextPending[key] = pendingPanelMessages[key]
        }
        pendingPanelMessages = nextPending
    }

    function addOrReplacePanel(payload) {
        if (!payload || !payload.id) return
        var panel = resolvePanel(payload, payload.id)
        var existingIndex = findPanelIndexById(payload.id)
        if (existingIndex >= 0) {
            panelsModel.set(existingIndex, panel)
        } else {
            panelsModel.append(panel)
        }
    }

    function removePanelById(panelId) {
        var removeIndex = findPanelIndexById(panelId)
        if (removeIndex < 0 || panelsModel.count <= 1) return
        panelsModel.remove(removeIndex)
        if (activePanelIndex === removeIndex || activePanelIndex >= panelsModel.count) {
            activePanelIndex = 0
        }
    }

    onActivePanelIndexChanged: {
        flushPendingForActivePanel()
        var loader = panelRepeater.itemAt(activePanelIndex)
        activePanelLoaderStatus = loader ? loader.status : Loader.Null
    }

    Component.onCompleted: {
        var initial = normalizePanels(bridge.props.panels)
        for (var i = 0; i < initial.length; i++) {
            panelsModel.append(initial[i])
        }
    }

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
                    model: panelsModel
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
                                text: model.icon || "●"
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                color: index === root.activePanelIndex
                                    ? SpellUI.SpellTheme.primary
                                    : SpellUI.SpellTheme.textSecondary
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: model.title || "Panel"
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

            Item {
                id: panelContainer
                anchors.fill: parent

                Repeater {
                    id: panelRepeater
                    model: panelsModel
                    delegate: Loader {
                        anchors.fill: parent
                        source: model.path || ""
                        visible: index === root.activePanelIndex
                        onLoaded: {
                            if (index === root.activePanelIndex)
                                root.flushPendingForActivePanel()
                        }
                        onStatusChanged: {
                            if (index === root.activePanelIndex)
                                root.activePanelLoaderStatus = status
                        }
                    }
                }
            }

            // Error overlay
            Rectangle {
                anchors.fill: parent
                color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.background, 0.9)
                visible: root.activePanelLoaderStatus === Loader.Error

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
                        text: {
                            var loader = panelRepeater.itemAt(root.activePanelIndex)
                            return loader ? (loader.source + "") : ""
                        }
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
                                var loader = panelRepeater.itemAt(root.activePanelIndex)
                                if (loader) {
                                    var src = loader.source
                                    loader.source = ""
                                    loader.source = src
                                }
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
