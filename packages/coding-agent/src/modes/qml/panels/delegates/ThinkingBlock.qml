import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "thinkingBlock"

    required property string text

    property bool expanded: false
    property bool showSeparator: false

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

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
            objectName: "thinkingHeader"
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

                Text {
                    text: "Thinking"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.italic: true
                    color: SpellUI.SpellTheme.textTertiary
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: root.expanded ? "Hide" : "Show"
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textTertiary
                }
            }

            SpellUI.StateLayer {
                onClicked: root.expanded = !root.expanded
            }
        }

        Item {
            Layout.fillWidth: true
            implicitHeight: root.expanded ? thinkingText.implicitHeight : 0
            clip: true

            Behavior on implicitHeight {
                NumberAnimation {
                    duration: SpellUI.SpellTheme.durationNormal
                    easing.type: Easing.OutQuad
                }
            }

            Text {
                id: thinkingText
                objectName: "thinkingBody"
                visible: root.expanded
                width: parent.width
                text: root.text
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                font.italic: true
                color: SpellUI.SpellTheme.textTertiary
                wrapMode: Text.Wrap
            }
        }
    }
}
