import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "flowImage"

    required property string text
    required property string name
    property bool showSeparator: false
    property bool expanded: false

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    ColumnLayout {
        id: content
        width: parent.width
        spacing: SpellUI.SpellTheme.spacingM

        Rectangle {
            Layout.fillWidth: true
            height: 1
            visible: root.showSeparator
            color: SpellUI.SpellTheme.borderSubtle
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: root.expanded ? 420 : 240
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            Image {
                id: inlineImage
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                fillMode: Image.PreserveAspectFit
                source: root.text.length > 0 ? "data:" + root.name + ";base64," + root.text : ""
            }

            Text {
                anchors.centerIn: parent
                visible: inlineImage.status === Image.Error
                text: "Image preview unavailable"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                color: SpellUI.SpellTheme.textTertiary
            }

            SpellUI.StateLayer {
                onClicked: root.expanded = !root.expanded
            }
        }
    }
}
