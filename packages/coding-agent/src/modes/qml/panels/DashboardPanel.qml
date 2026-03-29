import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: dashboardPanel

    property string agentStatus: "idle"
    property string agentElapsed: ""
    property int queueP1: 0
    property int queueP2: 0
    property int queueP3: 0
    property var orchestrators: []
    property var canvasWindows: []
    property int tokenCount: 0

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object") return
        var handler = handlers[payload.type]
        if (handler) handler(payload)
    }

    property var handlers: ({
        dashboard_update: function(msg) {
            if (msg.agent && typeof msg.agent === "object") {
                if (msg.agent.status !== undefined) dashboardPanel.agentStatus = String(msg.agent.status)
                if (msg.agent.elapsed !== undefined) dashboardPanel.agentElapsed = String(msg.agent.elapsed)
            }

            if (msg.queue && typeof msg.queue === "object") {
                if (msg.queue.p1 !== undefined) dashboardPanel.queueP1 = Number(msg.queue.p1) || 0
                if (msg.queue.p2 !== undefined) dashboardPanel.queueP2 = Number(msg.queue.p2) || 0
                if (msg.queue.p3 !== undefined) dashboardPanel.queueP3 = Number(msg.queue.p3) || 0
            }

            if (msg.orchestrators !== undefined && Array.isArray(msg.orchestrators)) {
                dashboardPanel.orchestrators = msg.orchestrators
            }

            if (msg.windows !== undefined && Array.isArray(msg.windows)) {
                dashboardPanel.canvasWindows = msg.windows
            }

            if (msg.tokens !== undefined) {
                dashboardPanel.tokenCount = Number(msg.tokens) || 0
            }
        },
        todo_snapshot: function(msg) {
            if (todoPanelLoader.item && todoPanelLoader.item.handleMessage) {
                todoPanelLoader.item.handleMessage(msg)
            }
        }
    })

    function statusColor(status) {
        if (status === "busy") return SpellUI.SpellTheme.success
        if (status === "blocked") return SpellUI.SpellTheme.warning
        if (status === "error") return SpellUI.SpellTheme.error
        return SpellUI.SpellTheme.textTertiary
    }

    function queueColor(value) {
        if (value > 50) return SpellUI.SpellTheme.error
        if (value > 10) return SpellUI.SpellTheme.warning
        return SpellUI.SpellTheme.textPrimary
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString()
    }

    Rectangle {
        anchors.fill: parent
        color: SpellUI.SpellTheme.background
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingL
        spacing: SpellUI.SpellTheme.spacingL

        Text {
            text: "Dashboard"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
            font.bold: true
            color: SpellUI.SpellTheme.textPrimary
        }

        Rectangle {
            Layout.fillWidth: true
            color: SpellUI.SpellTheme.surface
            radius: SpellUI.SpellTheme.cornerRadius
            border.width: 1
            border.color: SpellUI.SpellTheme.outline
            implicitHeight: statusContent.implicitHeight + SpellUI.SpellTheme.spacingL * 2

            ColumnLayout {
                id: statusContent
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingS

                RowLayout {
                    spacing: SpellUI.SpellTheme.spacingS

                    Rectangle {
                        id: statusDot
                        width: 8
                        height: 8
                        radius: 4
                        color: dashboardPanel.statusColor(dashboardPanel.agentStatus)

                        SequentialAnimation on opacity {
                            running: dashboardPanel.agentStatus === "busy"
                            loops: Animation.Infinite
                            NumberAnimation { from: 1.0; to: 0.3; duration: 500 }
                            NumberAnimation { from: 0.3; to: 1.0; duration: 500 }
                        }
                    }

                    Text {
                        text: "Agent is " + dashboardPanel.agentStatus
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                        color: SpellUI.SpellTheme.textPrimary
                    }
                }

                Text {
                    visible: dashboardPanel.agentStatus === "busy" && dashboardPanel.agentElapsed.length > 0
                    text: "Elapsed: " + dashboardPanel.agentElapsed
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            color: SpellUI.SpellTheme.surface
            radius: SpellUI.SpellTheme.cornerRadius
            border.width: 1
            border.color: SpellUI.SpellTheme.outline
            implicitHeight: queueContent.implicitHeight + SpellUI.SpellTheme.spacingL * 2

            ColumnLayout {
                id: queueContent
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: "Queue Depth"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                    font.bold: true
                    color: SpellUI.SpellTheme.textPrimary
                }

                Repeater {
                    model: [
                        { label: "P1", count: dashboardPanel.queueP1 },
                        { label: "P2", count: dashboardPanel.queueP2 },
                        { label: "P3", count: dashboardPanel.queueP3 }
                    ]

                    delegate: RowLayout {
                        Layout.fillWidth: true

                        Text {
                            text: modelData.label
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        Item { Layout.fillWidth: true }

                        Text {
                            text: dashboardPanel.formatNumber(modelData.count)
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            font.bold: true
                            color: dashboardPanel.queueColor(modelData.count)
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: SpellUI.SpellTheme.surface
            radius: SpellUI.SpellTheme.cornerRadius
            border.width: 1
            border.color: SpellUI.SpellTheme.outline

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingS

                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        text: "Orchestrators"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                        font.bold: true
                        color: SpellUI.SpellTheme.textPrimary
                    }

                    Rectangle {
                        color: SpellUI.SpellTheme.surfaceHigher
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        implicitWidth: badgeText.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: badgeText.implicitHeight + SpellUI.SpellTheme.spacingXS

                        Text {
                            id: badgeText
                            anchors.centerIn: parent
                            text: String(dashboardPanel.orchestrators.length)
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.textPrimary
                        }
                    }
                }

                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: SpellUI.SpellTheme.spacingXS
                    model: dashboardPanel.orchestrators
                    visible: dashboardPanel.orchestrators.length > 0

                    delegate: Rectangle {
                        required property var modelData
                        width: ListView.view.width
                        color: SpellUI.SpellTheme.surfaceHigh
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        border.width: 1
                        border.color: SpellUI.SpellTheme.outline
                        implicitHeight: orchRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2

                        RowLayout {
                            id: orchRow
                            anchors.fill: parent
                            anchors.margins: SpellUI.SpellTheme.spacingS
                            spacing: SpellUI.SpellTheme.spacingS

                            Text {
                                text: modelData.windowId || ""
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                color: SpellUI.SpellTheme.textPrimary
                            }

                            Text {
                                Layout.fillWidth: true
                                text: modelData.scope || ""
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                color: SpellUI.SpellTheme.textSecondary
                                elide: Text.ElideRight
                            }
                        }
                    }
                }

                Text {
                    visible: dashboardPanel.orchestrators.length === 0
                    text: "No active orchestrators"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textTertiary
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            color: SpellUI.SpellTheme.surface
            radius: SpellUI.SpellTheme.cornerRadius
            border.width: 1
            border.color: SpellUI.SpellTheme.outline
            implicitHeight: windowsContent.implicitHeight + SpellUI.SpellTheme.spacingL * 2

            ColumnLayout {
                id: windowsContent
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingS

                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        text: "Canvas Windows"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                        font.bold: true
                        color: SpellUI.SpellTheme.textPrimary
                    }

                    Rectangle {
                        color: SpellUI.SpellTheme.surfaceHigher
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        implicitWidth: windowBadgeText.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: windowBadgeText.implicitHeight + SpellUI.SpellTheme.spacingXS

                        Text {
                            id: windowBadgeText
                            anchors.centerIn: parent
                            text: String(dashboardPanel.canvasWindows.length)
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.textPrimary
                        }
                    }
                }

                ListView {
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(contentHeight, 140)
                    clip: true
                    spacing: SpellUI.SpellTheme.spacingXS
                    model: dashboardPanel.canvasWindows
                    visible: dashboardPanel.canvasWindows.length > 0

                    delegate: Rectangle {
                        required property var modelData
                        width: ListView.view.width
                        color: SpellUI.SpellTheme.surfaceHigh
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        border.width: 1
                        border.color: SpellUI.SpellTheme.outline
                        implicitHeight: windowColumn.implicitHeight + SpellUI.SpellTheme.spacingS * 2

                        ColumnLayout {
                            id: windowColumn
                            anchors.fill: parent
                            anchors.margins: SpellUI.SpellTheme.spacingS
                            spacing: SpellUI.SpellTheme.spacingXS

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: (modelData.id || "") + " · " + (modelData.title || "")
                                    Layout.fillWidth: true
                                    font.family: SpellUI.SpellTheme.fontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                    color: SpellUI.SpellTheme.textPrimary
                                    elide: Text.ElideRight
                                }

                                Text {
                                    text: modelData.state || ""
                                    font.family: SpellUI.SpellTheme.monoFontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                    color: SpellUI.SpellTheme.textSecondary
                                }
                            }
                        }
                    }
                }

                Text {
                    visible: dashboardPanel.canvasWindows.length === 0
                    text: "No canvas windows"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textTertiary
                }
            }
        }

        // Todo tasks section (visible when tasks exist)
        Loader {
            id: todoPanelLoader
            Layout.fillWidth: true
            Layout.preferredHeight: item ? Math.min(item.implicitHeight, 300) : 0
            visible: item && item.todoPhases && item.todoPhases.length > 0
            source: "TodoPanel.qml"
            asynchronous: false

            Connections {
                target: todoPanelLoader.item
                function onControlRequested(taskId: string, gate: string, enabled: bool): void {
                    if (typeof bridge !== "undefined" && bridge && bridge.send) {
                        bridge.send({
                            action: "todo_control",
                            taskId: taskId,
                            gate: gate,
                            enabled: enabled
                        })
                    }
                }
            }
        }

        Text {
            Layout.alignment: Qt.AlignRight
            text: "Tokens: " + dashboardPanel.formatNumber(dashboardPanel.tokenCount)
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            color: SpellUI.SpellTheme.textSecondary
        }
    }
}
