import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Rectangle {
    id: root
    radius: ShellTheme.SpellTheme.cornerRadius
    color: Qt.rgba(ShellTheme.SpellTheme.warning.r, ShellTheme.SpellTheme.warning.g, ShellTheme.SpellTheme.warning.b, 0.14)
    border.width: 1
    border.color: Qt.rgba(ShellTheme.SpellTheme.warning.r, ShellTheme.SpellTheme.warning.g, ShellTheme.SpellTheme.warning.b, 0.45)

    property string title: "Preview only"
    property string message: "Interactive rendering is unavailable. The document remains viewable and exportable."
    property string actionText: "Open recovery"
    property bool actionVisible: true

    signal actionTriggered()

    implicitHeight: bannerLayout.implicitHeight + ShellTheme.SpellTheme.spacingM * 2

    RowLayout {
        id: bannerLayout
        anchors.fill: parent
        anchors.margins: ShellTheme.SpellTheme.spacingM
        spacing: ShellTheme.SpellTheme.spacingM

        Rectangle {
            Layout.preferredWidth: 32
            Layout.preferredHeight: 32
            radius: 16
            color: Qt.rgba(ShellTheme.SpellTheme.warning.r, ShellTheme.SpellTheme.warning.g, ShellTheme.SpellTheme.warning.b, 0.22)

            Text {
                anchors.centerIn: parent
                text: "!"
                color: ShellTheme.SpellTheme.warning
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
            visible: root.actionVisible
            text: root.actionText
            flat: true
            onClicked: root.actionTriggered()

            background: Rectangle {
                radius: ShellTheme.SpellTheme.cornerRadiusSmall
                color: ShellTheme.SpellTheme.primaryContainer
                border.width: 1
                border.color: ShellTheme.SpellTheme.primary
            }

            contentItem: Text {
                text: parent.text
                color: ShellTheme.SpellTheme.primary
                font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                font.weight: ShellTheme.SpellTheme.fontWeightMedium
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }
        }
    }
}
