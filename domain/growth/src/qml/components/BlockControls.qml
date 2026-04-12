import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

RowLayout {
    id: root
    spacing: ShellTheme.SpellTheme.spacingS

    property string currentKind: "paragraph"
    property int currentLevel: 1

    signal blockKindSelected(string kind, int level)

    function isActive(kind) {
        return root.currentKind === kind
    }

    Repeater {
        model: [
            { kind: "paragraph", label: "Paragraph", level: 1 },
            { kind: "heading", label: "Heading", level: root.currentLevel > 0 ? root.currentLevel : 1 },
            { kind: "list_item", label: "List", level: 1 }
        ]

        delegate: Button {
            text: modelData.label
            flat: true
            implicitHeight: 34
            implicitWidth: Math.max(92, contentItem.implicitWidth + 20)

            background: Rectangle {
                radius: ShellTheme.SpellTheme.cornerRadius
                color: root.isActive(modelData.kind)
                    ? ShellTheme.SpellTheme.primaryContainer
                    : ShellTheme.SpellTheme.surface1
                border.width: 1
                border.color: root.isActive(modelData.kind)
                    ? ShellTheme.SpellTheme.primary
                    : ShellTheme.SpellTheme.borderSubtle
            }

            contentItem: Text {
                text: modelData.label
                color: root.isActive(modelData.kind)
                    ? ShellTheme.SpellTheme.primary
                    : ShellTheme.SpellTheme.textSecondary
                font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                font.weight: ShellTheme.SpellTheme.fontWeightMedium
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }

            onClicked: root.blockKindSelected(modelData.kind, modelData.level)
        }
    }
}
