import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "flowTool"

    required property string text
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false
    property bool showSeparator: false

    signal toggleExpanded(int index)

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    function statusLabel() {
        if (root.isStreaming) return "running"
        if (root.isError) return "error"
        return "done"
    }

    function statusColor() {
        if (root.isStreaming) return SpellUI.SpellTheme.primary
        if (root.isError) return SpellUI.SpellTheme.error
        return SpellUI.SpellTheme.success
    }

    ColumnLayout {
        id: content
        width: parent.width
        spacing: SpellUI.SpellTheme.spacingXS

        Rectangle {
            Layout.fillWidth: true
            height: 1
            visible: root.showSeparator
            color: SpellUI.SpellTheme.borderSubtle
        }

        Rectangle {
            id: header
            objectName: "toolHeader"
            Layout.fillWidth: true
            implicitHeight: headerRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            RowLayout {
                id: headerRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle {
                    Layout.preferredWidth: 8
                    Layout.preferredHeight: 8
                    radius: 4
                    color: root.statusColor()
                }

                Text {
                    text: root.name
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: root.statusLabel()
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: root.statusColor()
                }
            }

            SpellUI.StateLayer {
                onClicked: root.toggleExpanded(root.messageIndex)
            }
        }

        Item {
            Layout.fillWidth: true
            implicitHeight: root.isExpanded && root.text.length > 0 ? details.implicitHeight : 0
            clip: true

            Behavior on implicitHeight {
                NumberAnimation {
                    duration: SpellUI.SpellTheme.durationNormal
                    easing.type: Easing.OutQuad
                }
            }

            Text {
                id: details
                objectName: "toolDetails"
                visible: root.isExpanded && root.text.length > 0
                width: parent.width
                text: root.text
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                color: root.isError ? SpellUI.SpellTheme.error : SpellUI.SpellTheme.textTertiary
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
            }
        }
    }
}
