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
    property var canvasOutput: null

    radius: SpellUI.SpellTheme.cornerRadius
    color: SpellUI.SpellTheme.surface0
    border.width: 1
    border.color: SpellUI.SpellTheme.borderSubtle

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
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 140
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

        Loader {
            id: outputLoader
            Layout.fillWidth: true
            active: root.canvasOutput !== null && root.canvasOutput !== undefined
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
