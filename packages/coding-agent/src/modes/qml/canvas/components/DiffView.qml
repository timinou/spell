import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    required property var diffData
    implicitHeight: diffLayout.implicitHeight

    signal lineClicked(int lineIndex, string lineType, string text)
    signal hunkApproved(int hunkIndex)
    signal hunkRejected(int hunkIndex)

    // Build flat line list from hunks for display
    property var flatLines: {
        if (!diffData || !diffData.hunks) return []
        var result = []
        var lineNum = 0
        for (var h = 0; h < diffData.hunks.length; h++) {
            var hunk = diffData.hunks[h]
            // Hunk header line
            result.push({ type: "header", text: hunk.header || "", hunkIndex: h, lineIndex: lineNum++ })
            var lines = hunk.lines || []
            for (var l = 0; l < lines.length; l++) {
                result.push({ type: lines[l].type || "context", text: lines[l].text || "", hunkIndex: h, lineIndex: lineNum++ })
            }
        }
        return result
    }

    ColumnLayout {
        id: diffLayout
        anchors.fill: parent
        spacing: 0

        // Filename header
        Rectangle {
            visible: diffData && diffData.filename
            Layout.fillWidth: true
            height: 32
            color: SpellUI.SpellTheme.surfaceHigher
            radius: SpellUI.SpellTheme.cornerRadius
            objectName: "diffFilenameHeader"

            Text {
                anchors { fill: parent; margins: 8 }
                text: diffData ? (diffData.filename || "") : ""
                color: SpellUI.SpellTheme.textPrimary
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                font.bold: true
                verticalAlignment: Text.AlignVCenter
            }
        }

        // No-changes indicator
        Text {
            visible: flatLines.length === 0
            text: "No changes"
            color: SpellUI.SpellTheme.textTertiary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: SpellUI.SpellTheme.spacingL
            objectName: "noChangesIndicator"
        }

        // Diff lines
        ListView {
            id: diffListView
            Layout.fillWidth: true
            Layout.preferredHeight: contentHeight
            model: flatLines
            interactive: false
            clip: true

            delegate: Item {
                required property var modelData
                required property int index
                width: diffListView.width
                height: lineRect.height

                property color lineColor: {
                    switch (modelData.type) {
                        case "add": return Qt.rgba(0.25, 0.73, 0.31, 0.12)
                        case "remove": return Qt.rgba(0.97, 0.32, 0.29, 0.12)
                        case "header": return SpellUI.SpellTheme.surfaceHigher
                        default: return "transparent"
                    }
                }

                Rectangle {
                    id: lineRect
                    width: parent.width
                    height: lineText.implicitHeight + 8
                    color: lineColor
                    objectName: {
                        switch (modelData.type) {
                            case "add": return "addedLine"
                            case "remove": return "removedLine"
                            case "header": return "hunkHeader"
                            default: return "contextLine"
                        }
                    }

                    RowLayout {
                        anchors { fill: parent; margins: 4 }
                        spacing: 4

                        // Line number
                        Text {
                            text: modelData.type === "header" ? "" : String(modelData.lineIndex + 1)
                            color: SpellUI.SpellTheme.textTertiary
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            Layout.preferredWidth: 30
                            horizontalAlignment: Text.AlignRight
                        }

                        // +/- gutter
                        Text {
                            text: {
                                switch (modelData.type) {
                                    case "add": return "+"
                                    case "remove": return "-"
                                    default: return " "
                                }
                            }
                            color: {
                                switch (modelData.type) {
                                    case "add": return SpellUI.SpellTheme.success
                                    case "remove": return SpellUI.SpellTheme.error
                                    default: return SpellUI.SpellTheme.textTertiary
                                }
                            }
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            font.bold: true
                            Layout.preferredWidth: 14
                        }

                        // Line text
                        Text {
                            id: lineText
                            text: modelData.text || ""
                            color: modelData.type === "header" ? SpellUI.SpellTheme.textSecondary : SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            wrapMode: Text.NoWrap
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        onClicked: root.lineClicked(modelData.lineIndex, modelData.type, modelData.text)
                    }
                }
            }
        }
    }
}
