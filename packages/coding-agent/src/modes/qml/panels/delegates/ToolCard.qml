import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Rectangle {
    id: root
    objectName: "toolCard"
    required property string text
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false

    signal toggleExpanded(int index)

    width: parent ? parent.width : 0
    height: toolColumn.height + SpellUI.SpellTheme.spacingM * 2
    color: SpellUI.SpellTheme.surfaceHigher
    radius: SpellUI.SpellTheme.cornerRadius
    border.color: root.isError ? SpellUI.SpellTheme.error : "transparent"
    border.width: root.isError ? 2 : 0

    ColumnLayout {
        id: toolColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingS

        // Tool header
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 28
            color: "transparent"

            Row {
                anchors.fill: parent
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "\u2699"
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.name
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }

                Item { width: 1; height: 1; Layout.fillWidth: true }

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.isStreaming ? "\u27F3" : (root.isError ? "\u2717" : "\u2713")
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: root.isStreaming ? SpellUI.SpellTheme.warning
                         : root.isError ? SpellUI.SpellTheme.error
                         : SpellUI.SpellTheme.success
                }
            }

            SpellUI.StateLayer {
                onClicked: root.toggleExpanded(root.messageIndex)
            }
        }

        // Progress indicator (pulsing bar during streaming)
        Rectangle {
            objectName: "toolProgress"
            Layout.fillWidth: true
            Layout.preferredHeight: 3
            visible: root.isStreaming
            color: "transparent"

            Rectangle {
                id: progressBar
                width: parent.width * 0.3
                height: parent.height
                radius: 1.5
                color: SpellUI.SpellTheme.primary

                SequentialAnimation on x {
                    running: root.isStreaming
                    loops: Animation.Infinite
                    NumberAnimation {
                        from: 0
                        to: root.width * 0.7
                        duration: 1000
                        easing.type: Easing.InOutQuad
                    }
                    NumberAnimation {
                        from: root.width * 0.7
                        to: 0
                        duration: 1000
                        easing.type: Easing.InOutQuad
                    }
                }
            }
        }

        // Tool details (collapsible)
        Text {
            Layout.fillWidth: true
            visible: root.isExpanded && root.text.length > 0
            text: root.text
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            color: SpellUI.SpellTheme.textSecondary
            wrapMode: Text.Wrap
            textFormat: Text.PlainText
        }
    }
}
