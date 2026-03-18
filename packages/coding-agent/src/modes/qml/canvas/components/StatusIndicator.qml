import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var statusData
    implicitHeight: contentLayout.implicitHeight

    signal statusClicked()

    property string currentState: {
        var state = statusData && statusData.state ? String(statusData.state) : "idle"
        return state.toLowerCase()
    }

    function stateColor(state) {
        switch (state) {
            case "idle": return SpellUI.SpellTheme.textTertiary
            case "thinking": return SpellUI.SpellTheme.primary
            case "working": return SpellUI.SpellTheme.success
            case "blocked": return SpellUI.SpellTheme.warning
            case "error": return SpellUI.SpellTheme.error
            default: return SpellUI.SpellTheme.textTertiary
        }
    }

    function capitalizedState(state) {
        var safeState = state && state.length > 0 ? state : "idle"
        return safeState.charAt(0).toUpperCase() + safeState.slice(1)
    }

    property string displayLabel: {
        if (statusData && statusData.label)
            return String(statusData.label)
        return capitalizedState(currentState)
    }

    property string elapsedText: statusData && statusData.elapsed ? String(statusData.elapsed) : ""
    property string detailText: statusData && statusData.detail ? String(statusData.detail) : ""

    ColumnLayout {
        id: contentLayout
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingXS

        RowLayout {
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS

            Rectangle {
                id: statusDot
                width: 10
                height: 10
                radius: 5
                color: root.stateColor(root.currentState)
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle
            }

            Text {
                text: root.displayLabel
                color: SpellUI.SpellTheme.textPrimary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                font.weight: SpellUI.SpellTheme.fontWeightMedium
                Layout.fillWidth: true
                elide: Text.ElideRight
            }

            Text {
                visible: root.elapsedText !== ""
                text: root.elapsedText
                color: SpellUI.SpellTheme.textSecondary
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                horizontalAlignment: Text.AlignRight
            }
        }

        Text {
            visible: root.detailText !== ""
            text: root.detailText
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            Layout.fillWidth: true
            Layout.leftMargin: 10 + SpellUI.SpellTheme.spacingS
            elide: Text.ElideRight
        }
    }

    SequentialAnimation {
        id: pulseAnimation
        running: root.currentState === "thinking" || root.currentState === "working"
        loops: Animation.Infinite

        NumberAnimation {
            target: statusDot
            property: "opacity"
            from: 1.0
            to: 0.3
            duration: SpellUI.SpellTheme.durationMedium
        }

        NumberAnimation {
            target: statusDot
            property: "opacity"
            from: 0.3
            to: 1.0
            duration: SpellUI.SpellTheme.durationMedium
        }

        onRunningChanged: {
            if (!running)
                statusDot.opacity = 1.0
        }
    }

    MouseArea {
        anchors.fill: parent
        onClicked: root.statusClicked()
    }
}
