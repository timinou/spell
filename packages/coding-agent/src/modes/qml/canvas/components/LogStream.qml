import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var logData
    implicitHeight: (logData && logData.height) ? Number(logData.height) : 300

    property bool userScrolledAway: false
    property bool programmaticScroll: false
    property int bottomThreshold: 8

    property int maxVisibleLines: {
        if (!logData) return 500
        var configured = Number(logData.maxLines)
        if (!isFinite(configured) || configured <= 0) return 500
        return Math.floor(configured)
    }

    property var allLines: {
        if (!logData || !logData.lines) return []
        return logData.lines
    }

    property var visibleLines: {
        var lines = allLines
        if (lines.length <= maxVisibleLines) return lines
        return lines.slice(lines.length - maxVisibleLines)
    }

    property int visibleStartNumber: Math.max(1, allLines.length - visibleLines.length + 1)

    function isAtBottom() {
        var maxY = logListView.contentHeight - logListView.height
        if (maxY <= 0) return true
        return logListView.contentY >= (maxY - bottomThreshold)
    }

    function scrollToBottom() {
        if (visibleLines.length === 0) return
        programmaticScroll = true
        logListView.positionViewAtEnd()
        programmaticReleaseTimer.restart()
    }

    onLogDataChanged: {
        if (!userScrolledAway && (!logData || logData.autoFollow !== false)) {
            scrollToBottom()
        }
    }

    onVisibleLinesChanged: {
        if (!userScrolledAway && (!logData || logData.autoFollow !== false)) {
            scrollToBottom()
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            visible: root.logData && root.logData.title
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? 34 : 0
            color: SpellUI.SpellTheme.surfaceHigh
            radius: SpellUI.SpellTheme.cornerRadiusSmall

            Text {
                anchors.fill: parent
                anchors.leftMargin: SpellUI.SpellTheme.spacingM
                anchors.rightMargin: SpellUI.SpellTheme.spacingM
                text: root.logData ? (root.logData.title || "") : ""
                color: SpellUI.SpellTheme.textPrimary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                font.bold: true
                verticalAlignment: Text.AlignVCenter
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: SpellUI.SpellTheme.surface
            border.color: SpellUI.SpellTheme.outline
            radius: SpellUI.SpellTheme.cornerRadius

            Text {
                visible: root.visibleLines.length === 0
                anchors.centerIn: parent
                text: "No log entries"
                color: SpellUI.SpellTheme.textTertiary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                objectName: "emptyPlaceholder"
            }

            ListView {
                id: logListView
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                clip: true
                spacing: 2
                model: root.visibleLines

                onContentYChanged: {
                    if (root.programmaticScroll)
                        return
                    root.userScrolledAway = !root.isAtBottom()
                }

                onMovementEnded: {
                    root.userScrolledAway = !root.isAtBottom()
                }

                delegate: Item {
                    required property var modelData
                    required property int index
                    width: logListView.width
                    height: Math.max(lineText.implicitHeight, lineNumber.implicitHeight) + 2

                    RowLayout {
                        anchors.fill: parent
                        spacing: SpellUI.SpellTheme.spacingS

                        Text {
                            id: lineNumber
                            Layout.preferredWidth: 40
                            horizontalAlignment: Text.AlignRight
                            text: String(root.visibleStartNumber + index)
                            color: SpellUI.SpellTheme.textTertiary
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        }

                        Text {
                            id: lineText
                            Layout.fillWidth: true
                            text: modelData && modelData.text ? String(modelData.text) : ""
                            wrapMode: Text.WrapAnywhere
                            color: {
                                var level = (modelData && modelData.level) ? String(modelData.level) : "info"
                                switch (level) {
                                case "info": return SpellUI.SpellTheme.textPrimary
                                case "warn": return SpellUI.SpellTheme.warning
                                case "error": return SpellUI.SpellTheme.error
                                case "debug": return SpellUI.SpellTheme.textTertiary
                                default: return SpellUI.SpellTheme.textSecondary
                                }
                            }
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        }
                    }
                }
            }
        }
    }

    Timer {
        id: programmaticReleaseTimer
        interval: 0
        repeat: false
        onTriggered: root.programmaticScroll = false
    }

    Component.onCompleted: {
        if (!userScrolledAway && (!logData || logData.autoFollow !== false)) {
            scrollToBottom()
        }
    }
}
