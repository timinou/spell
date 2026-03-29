import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: root
    property var nodes: []
    implicitHeight: content.implicitHeight

    ColumnLayout {
        id: content
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingXS

        Repeater {
            model: root.nodes
            delegate: RowLayout {
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle {
                    width: 8
                    height: 8
                    radius: 4
                    color: modelData.state === "complete" ? SpellUI.SpellTheme.success
                        : modelData.state === "paused" ? SpellUI.SpellTheme.warning
                        : modelData.state === "failed" ? SpellUI.SpellTheme.error
                        : SpellUI.SpellTheme.primary
                }

                Text {
                    text: modelData.name + " (" + modelData.state + ")"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textPrimary
                }
            }
        }
    }
}
