import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Drawer {
    id: root
    edge: Qt.RightEdge
    width: 300

    property var assets: []
    property string currentPath: ""

    signal assetPicked(string path)

    background: Rectangle {
        color: ShellTheme.SpellTheme.surface0
        border.width: 1
        border.color: ShellTheme.SpellTheme.borderDefault
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: ShellTheme.SpellTheme.spacingL
        spacing: ShellTheme.SpellTheme.spacingM

        Text {
            text: "Asset picker"
            color: ShellTheme.SpellTheme.textPrimary
            font.pixelSize: ShellTheme.SpellTheme.fontSizeL
            font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
        }

        Text {
            text: root.currentPath === "" ? "Select an image reference for the current block." : `Current asset: ${root.currentPath}`
            color: ShellTheme.SpellTheme.textSecondary
            font.pixelSize: ShellTheme.SpellTheme.fontSizeS
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: ShellTheme.SpellTheme.spacingS
            model: root.assets

            delegate: ItemDelegate {
                width: ListView.view.width
                height: 68

                background: Rectangle {
                    radius: ShellTheme.SpellTheme.cornerRadius
                    color: modelData.path === root.currentPath
                        ? ShellTheme.SpellTheme.primaryContainer
                        : (parent.hovered ? ShellTheme.SpellTheme.surface2 : ShellTheme.SpellTheme.surface1)
                    border.width: 1
                    border.color: modelData.path === root.currentPath
                        ? ShellTheme.SpellTheme.primary
                        : ShellTheme.SpellTheme.borderSubtle
                }

                contentItem: ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: ShellTheme.SpellTheme.spacingM
                    spacing: 2

                    Text {
                        text: modelData.label || modelData.path || ""
                        color: ShellTheme.SpellTheme.textPrimary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                        font.weight: ShellTheme.SpellTheme.fontWeightMedium
                    }

                    Text {
                        text: modelData.path || ""
                        color: ShellTheme.SpellTheme.textSecondary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeXS
                        elide: Text.ElideMiddle
                    }
                }

                onClicked: {
                    root.assetPicked(modelData.path || "")
                    root.close()
                }
            }
        }
    }
}
