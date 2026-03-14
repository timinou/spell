import QtQuick 2.15
import "../.." as SpellUI

Item {
    id: root
    required property string text       // base64 image data
    required property string name       // mime type
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false

    width: parent ? parent.width : 0
    height: inlineImage.status === Image.Ready ? inlineImage.paintedHeight + SpellUI.SpellTheme.spacingL * 2 : 100

    Rectangle {
        anchors.fill: parent
        color: SpellUI.SpellTheme.surfaceHigh
        radius: SpellUI.SpellTheme.cornerRadius

        Image {
            id: inlineImage
            objectName: "inlineImage"
            anchors.fill: parent
            anchors.margins: SpellUI.SpellTheme.spacingL
            fillMode: Image.PreserveAspectFit
            source: root.text.length > 0 ? "data:" + root.name + ";base64," + root.text : ""
        }
    }
}
