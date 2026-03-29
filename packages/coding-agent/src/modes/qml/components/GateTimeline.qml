import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: root
    property var gates: []
    implicitHeight: content.implicitHeight

    ColumnLayout {
        id: content
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingXS

        Repeater {
            model: root.gates
            delegate: RowLayout {
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: modelData.gateId
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }

                Text {
                    text: modelData.outcome
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: modelData.outcome === "pass" ? SpellUI.SpellTheme.success
                        : modelData.outcome === "fail" ? SpellUI.SpellTheme.error
                        : SpellUI.SpellTheme.warning
                }

                Text {
                    Layout.fillWidth: true
                    text: modelData.reason
                    elide: Text.ElideRight
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textPrimary
                }
            }
        }
    }
}
