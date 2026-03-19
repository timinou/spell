import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "../canvas" as Canvas

Rectangle {
    id: root

    property string agentId: ""
    property string agentTask: ""
    property string agentState: "pending"
    property string streamText: ""
    property string errorText: ""
    property string dependencyStatus: ""
    property real startedAt: 0
    property real completedAt: 0
    property real nowMs: Date.now()
    property bool expanded: false
    property var canvasOutput: null

    radius: SpellUI.SpellTheme.cornerRadius
    color: SpellUI.SpellTheme.surface0
    border.width: 1
    border.color: SpellUI.SpellTheme.borderSubtle
    implicitHeight: root.expanded ? 380 : 170

    function stateColor(state) {
        switch (state) {
        case "ready": return "#388BFD"
        case "running": return SpellUI.SpellTheme.warning
        case "completed": return SpellUI.SpellTheme.success
        case "failed": return SpellUI.SpellTheme.error
        case "pending":
        default: return SpellUI.SpellTheme.textTertiary
        }
    }

    function displayState(state) {
        if (!state || state.length === 0) return "pending"
        return state
    }

    function elapsedSeconds() {
        if (startedAt <= 0) return 0
        var endMs = completedAt > 0 ? completedAt : nowMs
        return Math.max(0, Math.floor((endMs - startedAt) / 1000))
    }

    function formatElapsed() {
        var secs = elapsedSeconds()
        var mins = Math.floor(secs / 60)
        var rem = secs % 60
        return mins + "m " + (rem < 10 ? "0" : "") + rem + "s"
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.agentState === "running" && root.startedAt > 0
        onTriggered: root.nowMs = Date.now()
    }

    onStartedAtChanged: nowMs = Date.now()

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingS

        RowLayout {
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Text {
                    Layout.fillWidth: true
                    text: root.agentId
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    elide: Text.ElideRight
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.agentTask.length > 0
                    text: root.agentTask
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                    elide: Text.ElideRight
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.startedAt > 0
                    text: "Elapsed: " + root.formatElapsed()
                    color: SpellUI.SpellTheme.textTertiary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.dependencyStatus.length > 0
                    text: root.dependencyStatus
                    color: SpellUI.SpellTheme.textTertiary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                    elide: Text.ElideRight
                }
            }

            Rectangle {
                Layout.alignment: Qt.AlignTop
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: Qt.rgba(
                    root.stateColor(root.agentState).r,
                    root.stateColor(root.agentState).g,
                    root.stateColor(root.agentState).b,
                    0.16
                )
                border.width: 1
                border.color: root.stateColor(root.agentState)
                implicitWidth: stateLabel.implicitWidth + SpellUI.SpellTheme.spacingM
                implicitHeight: stateLabel.implicitHeight + 6

                Text {
                    id: stateLabel
                    anchors.centerIn: parent
                    text: root.displayState(root.agentState)
                    color: root.stateColor(root.agentState)
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                    font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                }
            }

            Button {
                Layout.alignment: Qt.AlignTop
                text: root.expanded ? "Collapse" : "Expand"
                onClicked: root.expanded = !root.expanded
            }
        }

        Text {
            Layout.fillWidth: true
            visible: !root.expanded
            text: root.streamText.length > 0 || root.canvasOutput ? "Expand to view output" : "Expand to inspect activity"
            color: SpellUI.SpellTheme.textTertiary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: root.expanded
            Layout.preferredHeight: root.expanded ? 180 : 0
            Layout.minimumHeight: root.expanded ? 140 : 0
            visible: root.expanded
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.background
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            Flickable {
                id: streamFlick
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                contentWidth: width
                contentHeight: streamLabel.paintedHeight
                clip: true

                TextEdit {
                    id: streamLabel
                    width: streamFlick.width
                    readOnly: true
                    text: root.streamText
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    wrapMode: TextEdit.WrapAnywhere
                    selectByMouse: true
                }
            }

            Text {
                visible: root.streamText.length === 0
                anchors.centerIn: parent
                text: "Waiting for output..."
                color: SpellUI.SpellTheme.textTertiary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
            }
        }

        Text {
            Layout.fillWidth: true
            visible: root.agentState === "failed" && root.errorText.length > 0
            text: root.errorText
            color: SpellUI.SpellTheme.error
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
            wrapMode: Text.WordWrap
        }

        Loader {
            id: outputLoader
            Layout.fillWidth: true
            active: root.expanded && root.canvasOutput !== null && root.canvasOutput !== undefined
            sourceComponent: outputComponent
        }
    }

    Component {
        id: outputComponent

        Rectangle {
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface1
            border.width: 1
            border.color: SpellUI.SpellTheme.borderDefault
            implicitHeight: outputColumn.implicitHeight + SpellUI.SpellTheme.spacingM * 2

            ColumnLayout {
                id: outputColumn
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    Layout.fillWidth: true
                    visible: root.canvasOutput && root.canvasOutput.title
                    text: root.canvasOutput ? (root.canvasOutput.title || "") : ""
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                    elide: Text.ElideRight
                }

                Canvas.ContentBlock {
                    Layout.fillWidth: true
                    blockId: root.agentId + "_output"
                    blockType: root.canvasOutput && root.canvasOutput.blockType
                        ? String(root.canvasOutput.blockType)
                        : "markdown"
                    blockData: root.canvasOutput && root.canvasOutput.blockData
                        ? root.canvasOutput.blockData
                        : ({ text: "" })
                }
            }
        }
    }

    onStreamTextChanged: {
        Qt.callLater(function () {
            var bottom = streamFlick.contentHeight - streamFlick.height
            streamFlick.contentY = Math.max(0, bottom)
        })
    }
}
