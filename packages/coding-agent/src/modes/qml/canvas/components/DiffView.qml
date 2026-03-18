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
        if (!diffData || !diffData.hunks)
            return []

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
            if (h < diffData.hunks.length - 1)
                result.push({ type: "separator", hunkIndex: h })
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
            height: 38
            color: SpellUI.SpellTheme.surface1
            objectName: "diffFilenameHeader"

            Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: 1
                color: SpellUI.SpellTheme.borderSubtle
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: SpellUI.SpellTheme.spacingS
                anchors.rightMargin: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: "▎"
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    Layout.fillWidth: true
                    text: diffData ? (diffData.filename || "") : ""
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
            }
        }

        // No-changes indicator
        Item {
            visible: flatLines.length === 0
            Layout.fillWidth: true
            Layout.preferredHeight: 92
            objectName: "noChangesIndicator"

            Column {
                anchors.centerIn: parent
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: "No changes"
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                }
            }
        }

        // Diff lines in recessed well
        Rectangle {
            visible: flatLines.length > 0
            Layout.fillWidth: true
            Layout.preferredHeight: diffListView.contentHeight
            color: SpellUI.SpellTheme.background
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            ListView {
                id: diffListView
                anchors.fill: parent
                anchors.margins: 1
                model: flatLines
                interactive: false
                clip: true
                property int hoveredIndex: -1

                delegate: Item {
                    required property var modelData
                    required property int index
                    width: diffListView.width
                    height: lineRect.height

                    readonly property bool isSeparator: modelData.type === "separator"
                    readonly property color baseColor: {
                        switch (modelData.type) {
                        case "add":
                            return SpellUI.SpellTheme.diffAddBg()
                        case "remove":
                            return SpellUI.SpellTheme.diffRemoveBg()
                        case "header":
                            return SpellUI.SpellTheme.diffHunkBg()
                        default:
                            return "transparent"
                        }
                    }

                    Rectangle {
                        id: lineRect
                        width: parent.width
                        height: isSeparator ? 8 : (lineText.implicitHeight + 8)
                        color: {
                            if (isSeparator)
                                return "transparent"
                            if (diffListView.hoveredIndex === index)
                                return Qt.tint(baseColor, SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.surface1, 0.45))
                            return baseColor
                        }
                        Behavior on color {
                            enabled: !isSeparator && (diffListView.hoveredIndex === index || baseColor !== "transparent")
                            ColorAnimation {
                                duration: 120
                                easing.type: Easing.OutQuad
                            }
                        }
                        objectName: {
                            switch (modelData.type) {
                            case "add":
                                return "addedLine"
                            case "remove":
                                return "removedLine"
                            case "header":
                                return "hunkHeader"
                            case "separator":
                                return "hunkSeparator"
                            default:
                                return "contextLine"
                            }
                        }

                        Rectangle {
                            visible: isSeparator
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.horizontalCenter: parent.horizontalCenter
                            width: parent.width * 0.6
                            height: 1
                            color: SpellUI.SpellTheme.borderSubtle
                        }

                        RowLayout {
                            visible: !isSeparator
                            anchors.fill: parent
                            anchors.margins: 4
                            spacing: 0

                            // Line number
                            Text {
                                text: modelData.type === "header" ? "" : String(modelData.lineIndex + 1)
                                color: SpellUI.SpellTheme.textGhost
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                                font.letterSpacing: SpellUI.SpellTheme.trackingWide
                                Layout.preferredWidth: 44
                                horizontalAlignment: Text.AlignRight
                            }

                            // +/- gutter
                            Text {
                                text: {
                                    switch (modelData.type) {
                                    case "add":
                                        return "+"
                                    case "remove":
                                        return "-"
                                    default:
                                        return " "
                                    }
                                }
                                color: {
                                    switch (modelData.type) {
                                    case "add":
                                        return SpellUI.SpellTheme.success
                                    case "remove":
                                        return SpellUI.SpellTheme.error
                                    default:
                                        return SpellUI.SpellTheme.textTertiary
                                    }
                                }
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                                horizontalAlignment: Text.AlignHCenter
                                Layout.preferredWidth: 20
                            }

                            // Line text
                            Text {
                                id: lineText
                                text: modelData.text || ""
                                color: modelData.type === "header" ? SpellUI.SpellTheme.textSecondary : SpellUI.SpellTheme.textPrimary
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                lineHeightMode: Text.ProportionalHeight
                                lineHeight: SpellUI.SpellTheme.lineHeightMono
                                wrapMode: Text.NoWrap
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                                Layout.leftMargin: 8
                            }
                        }

                        MouseArea {
                            anchors.fill: parent
                            hoverEnabled: !isSeparator
                            enabled: !isSeparator
                            onEntered: diffListView.hoveredIndex = index
                            onExited: {
                                if (diffListView.hoveredIndex === index)
                                    diffListView.hoveredIndex = -1
                            }
                            onClicked: root.lineClicked(modelData.lineIndex, modelData.type, modelData.text)
                        }
                    }
                }
            }
        }
    }
}
