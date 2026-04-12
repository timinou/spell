import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Rectangle {
    id: root
    radius: ShellTheme.SpellTheme.cornerRadius
    color: Qt.rgba(ShellTheme.SpellTheme.error.r, ShellTheme.SpellTheme.error.g, ShellTheme.SpellTheme.error.b, 0.12)
    border.width: 1
    border.color: Qt.rgba(ShellTheme.SpellTheme.error.r, ShellTheme.SpellTheme.error.g, ShellTheme.SpellTheme.error.b, 0.5)

    property string title: "Recovery mode available"
    property string message: "Unsupported or invalid Typst syntax disabled direct editing. Use the hidden source view to recover safely."

    signal openRecoveryRequested()
    signal dismissRequested()

    implicitHeight: content.implicitHeight + ShellTheme.SpellTheme.spacingM * 2

    RowLayout {
        id: content
        anchors.fill: parent
        anchors.margins: ShellTheme.SpellTheme.spacingM
        spacing: ShellTheme.SpellTheme.spacingM

        Rectangle {
            Layout.preferredWidth: 32
            Layout.preferredHeight: 32
            radius: 16
            color: Qt.rgba(ShellTheme.SpellTheme.error.r, ShellTheme.SpellTheme.error.g, ShellTheme.SpellTheme.error.b, 0.18)

            Text {
                anchors.centerIn: parent
                text: "×"
                color: ShellTheme.SpellTheme.error
                font.pixelSize: ShellTheme.SpellTheme.fontSizeL
                font.weight: ShellTheme.SpellTheme.fontWeightBold
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 2

            Text {
                Layout.fillWidth: true
                text: root.title
                color: ShellTheme.SpellTheme.textPrimary
                font.pixelSize: ShellTheme.SpellTheme.fontSizeM
                font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
                wrapMode: Text.WordWrap
            }

            Text {
                Layout.fillWidth: true
                text: root.message
                color: ShellTheme.SpellTheme.textSecondary
                font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                wrapMode: Text.WordWrap
            }
        }

        Button {
            text: "Open source"
            flat: true
            onClicked: root.openRecoveryRequested()

            background: Rectangle {
                radius: ShellTheme.SpellTheme.cornerRadiusSmall
                color: Qt.rgba(ShellTheme.SpellTheme.error.r, ShellTheme.SpellTheme.error.g, ShellTheme.SpellTheme.error.b, 0.16)
                border.width: 1
                border.color: ShellTheme.SpellTheme.error
            }

            contentItem: Text {
                text: parent.text
                color: ShellTheme.SpellTheme.error
                font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                font.weight: ShellTheme.SpellTheme.fontWeightMedium
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }
        }

        ToolButton {
            text: "Dismiss"
            onClicked: root.dismissRequested()
        }
    }
}
