import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Rectangle {
    id: root

    property var agents: null
    property int completedCount: 0
    property int totalCount: 0
    property int failedCount: 0

    radius: SpellUI.SpellTheme.cornerRadiusSmall
    color: SpellUI.SpellTheme.surface1
    border.width: 1
    border.color: SpellUI.SpellTheme.borderSubtle
    implicitHeight: inspectorLayout.implicitHeight + SpellUI.SpellTheme.spacingM * 2

    readonly property real progressValue: totalCount > 0 ? (completedCount / totalCount) : 0

    RowLayout {
        id: inspectorLayout
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingM

        ProgressBar {
            Layout.fillWidth: true
            from: 0
            to: 1
            value: root.progressValue
        }

        Text {
            text: root.totalCount > 0
                ? (root.completedCount + "/" + root.totalCount + " agents completed")
                : "0 agents"
            color: SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            font.weight: SpellUI.SpellTheme.fontWeightMedium
        }

        Text {
            visible: root.failedCount > 0
            text: root.failedCount + " failed"
            color: SpellUI.SpellTheme.error
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
        }
    }
}
