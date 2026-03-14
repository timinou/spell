import QtQuick 2.15
import "../.." as SpellUI

Item {
    id: root
    required property string text
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false

    width: parent ? parent.width : 0
    height: userBubble.height

    Rectangle {
        id: userBubble
        anchors.right: parent.right
        width: Math.min(userText.implicitWidth + SpellUI.SpellTheme.spacingL * 2, parent.width * 0.75)
        height: userText.paintedHeight + SpellUI.SpellTheme.spacingL * 2
        color: SpellUI.SpellTheme.primaryContainer
        radius: SpellUI.SpellTheme.cornerRadius

        Text {
            id: userText
            anchors.fill: parent
            anchors.margins: SpellUI.SpellTheme.spacingL
            text: root.text
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            color: SpellUI.SpellTheme.textPrimary
            wrapMode: Text.Wrap
            textFormat: Text.PlainText
        }
    }
}
