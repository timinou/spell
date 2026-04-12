import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Popup {
    id: root
    modal: true
    focus: true
    padding: ShellTheme.SpellTheme.spacingM
    width: 240

    property var items: [
        { kind: "paragraph", label: "Paragraph" },
        { kind: "heading", label: "Heading" },
        { kind: "list_item", label: "Bullet list" },
        { kind: "image", label: "Image" }
    ]

    signal insertRequested(string kind)

    background: Rectangle {
        radius: ShellTheme.SpellTheme.cornerRadiusLarge
        color: ShellTheme.SpellTheme.surface0
        border.width: 1
        border.color: ShellTheme.SpellTheme.borderDefault
    }

    contentItem: ColumnLayout {
        spacing: ShellTheme.SpellTheme.spacingS

        Text {
            text: "Insert block"
            color: ShellTheme.SpellTheme.textPrimary
            font.pixelSize: ShellTheme.SpellTheme.fontSizeM
            font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
        }

        Repeater {
            model: root.items

            delegate: Button {
                Layout.fillWidth: true
                text: modelData.label
                flat: true
                onClicked: {
                    root.insertRequested(modelData.kind)
                    root.close()
                }

                background: Rectangle {
                    radius: ShellTheme.SpellTheme.cornerRadius
                    color: parent.hovered ? ShellTheme.SpellTheme.surface2 : ShellTheme.SpellTheme.surface1
                    border.width: 1
                    border.color: ShellTheme.SpellTheme.borderSubtle
                }

                contentItem: Text {
                    text: parent.text
                    color: ShellTheme.SpellTheme.textPrimary
                    font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }
    }
}
