import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "flowUser"

    required property string text
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

        Text {
            width: parent.width
            text: "You"
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            color: SpellUI.SpellTheme.textTertiary
            horizontalAlignment: Text.AlignRight
        }

        Text {
            width: parent.width
            text: root.text
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.textPrimary
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignRight
        }
    }
}
