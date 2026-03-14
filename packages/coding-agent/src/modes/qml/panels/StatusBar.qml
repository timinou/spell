import QtQuick 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Rectangle {
    id: root
    required property string modelName
    required property int tokenCount

    Layout.fillWidth: true
    Layout.preferredHeight: 28
    color: SpellUI.SpellTheme.surface

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: SpellUI.SpellTheme.spacingL
        anchors.rightMargin: SpellUI.SpellTheme.spacingL
        spacing: SpellUI.SpellTheme.spacingL

        Text {
            text: root.modelName || "\u2014"
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            color: SpellUI.SpellTheme.textSecondary
        }

        Item { Layout.fillWidth: true }

        Text {
            text: root.tokenCount > 0 ? root.tokenCount + " tokens" : ""
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            color: SpellUI.SpellTheme.textSecondary
        }
    }
}
