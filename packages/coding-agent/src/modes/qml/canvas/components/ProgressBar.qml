import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var progressData

    property real rawValue: {
        if (!progressData || progressData.value === undefined)
            return 0
        var parsed = Number(progressData.value)
        return isFinite(parsed) ? parsed : 0
    }

    property real rawMax: {
        if (!progressData || progressData.max === undefined)
            return 100
        var parsed = Number(progressData.max)
        return isFinite(parsed) ? parsed : 100
    }

    property real safeMax: rawMax > 0 ? rawMax : 100
    property bool indeterminate: rawValue < 0
    property real clampedValue: Math.max(0, Math.min(rawValue, safeMax))

    property string labelText: {
        if (progressData && progressData.label !== undefined && progressData.label !== null)
            return String(progressData.label)
        return indeterminate ? "In progress" : "Progress"
    }

    property string detailText: {
        if (indeterminate)
            return "Working..."
        var percent = safeMax > 0 ? Math.round((clampedValue / safeMax) * 100) : 0
        return Math.round(clampedValue) + " / " + Math.round(safeMax) + " (" + percent + "%)"
    }

    implicitHeight: progressLayout.implicitHeight

    ColumnLayout {
        id: progressLayout
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingXS

        Text {
            Layout.fillWidth: true
            text: root.labelText
            color: SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            font.weight: SpellUI.SpellTheme.fontWeightMedium
            elide: Text.ElideRight
        }

        ProgressBar {
            id: progressBar
            Layout.fillWidth: true
            from: 0
            to: root.safeMax
            value: root.clampedValue
            indeterminate: root.indeterminate

            background: Rectangle {
                implicitHeight: 10
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: SpellUI.SpellTheme.surface1
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle
            }

            contentItem: Item {
                Rectangle {
                    width: progressBar.indeterminate
                        ? Math.max(24, parent.width * 0.35)
                        : progressBar.visualPosition * parent.width
                    height: parent.height
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.primary
                    opacity: progressBar.indeterminate ? 0.75 : 1
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: root.detailText
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
            elide: Text.ElideRight
        }
    }
}
