import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property string query
    required property string sourcesJson
    required property string collapsed
    required property int index
    property bool showSeparator: false

    signal viewInTab(string tabId, string url, string title)
    signal toggleCollapsed(int index)

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    function parseSources() {
        try {
            return JSON.parse(root.sourcesJson)
        } catch (e) {
            return []
        }
    }

    function sourceTypeIcon(st) {
        if (st === "search") return "\uD83D\uDD0D"
        if (st === "fetch") return "\uD83D\uDCC4"
        if (st === "code_search") return "\uD83D\uDCBB"
        if (st === "browser") return "\uD83C\uDF10"
        if (st === "agent") return "\u2728"
        return ""
    }

    ColumnLayout {
        id: content
        width: parent.width
        spacing: SpellUI.SpellTheme.spacingS

        Rectangle {
            Layout.fillWidth: true
            height: 1
            visible: root.showSeparator
            color: SpellUI.SpellTheme.borderSubtle
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: headerRow.implicitHeight + SpellUI.SpellTheme.spacingM * 2
            color: SpellUI.SpellTheme.surface0
            radius: SpellUI.SpellTheme.cornerRadiusSmall

            RowLayout {
                id: headerRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: "\uD83D\uDD0D"
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                }

                Text {
                    Layout.fillWidth: true
                    text: "Search: " + root.query
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    color: SpellUI.SpellTheme.textPrimary
                    elide: Text.ElideRight
                }

                Rectangle {
                    implicitWidth: countText.implicitWidth + SpellUI.SpellTheme.spacingS * 2
                    implicitHeight: countText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.surface1

                    Text {
                        id: countText
                        anchors.centerIn: parent
                        text: {
                            var sources = root.parseSources()
                            return String(sources.length)
                        }
                        font.family: SpellUI.SpellTheme.monoFontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textTertiary
                    }
                }

                Text {
                    text: root.collapsed === "true" ? "\u25B6" : "\u25BC"
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textTertiary
                }
            }

            SpellUI.StateLayer {
                onClicked: root.toggleCollapsed(root.index)
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.leftMargin: SpellUI.SpellTheme.spacingL
            visible: root.collapsed === "true"
            spacing: SpellUI.SpellTheme.spacingXS

            Repeater {
                model: {
                    var sources = root.parseSources()
                    return Math.min(sources.length, 3)
                }

                delegate: Text {
                    required property int index
                    Layout.fillWidth: true
                    text: {
                        var sources = root.parseSources()
                        if (index < sources.length) {
                            var s = sources[index]
                            return root.sourceTypeIcon(s.sourceType || "search") + " " + (s.title || s.url || "")
                        }
                        return ""
                    }
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                    elide: Text.ElideRight
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.leftMargin: SpellUI.SpellTheme.spacingL
            visible: root.collapsed !== "true"
            spacing: SpellUI.SpellTheme.spacingS

            Repeater {
                model: root.collapsed !== "true" ? root.parseSources().length : 0

                delegate: Rectangle {
                    required property int index

                    Layout.fillWidth: true
                    implicitHeight: sourceCol.implicitHeight + SpellUI.SpellTheme.spacingS * 2
                    color: SpellUI.SpellTheme.surface0
                    radius: SpellUI.SpellTheme.cornerRadiusSmall

                    ColumnLayout {
                        id: sourceCol
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingS
                        spacing: SpellUI.SpellTheme.spacingXS

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: SpellUI.SpellTheme.spacingXS

                            Text {
                                text: {
                                    var sources = root.parseSources()
                                    if (index < sources.length) return root.sourceTypeIcon(sources[index].sourceType || "search")
                                    return ""
                                }
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            }

                            Text {
                                Layout.fillWidth: true
                                text: {
                                    var sources = root.parseSources()
                                    if (index < sources.length) {
                                        var url = sources[index].url || ""
                                        var match = url.match(/^[a-z]+:\/\/([^/]+)/i)
                                        return match ? match[1].replace(/^www\./, "") : url
                                    }
                                    return ""
                                }
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                color: SpellUI.SpellTheme.textTertiary
                                elide: Text.ElideRight
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            text: {
                                var sources = root.parseSources()
                                return index < sources.length ? (sources[index].title || "") : ""
                            }
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            font.weight: SpellUI.SpellTheme.fontWeightMedium
                            color: SpellUI.SpellTheme.textPrimary
                            wrapMode: Text.Wrap
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: {
                                var sources = root.parseSources()
                                return index < sources.length && (sources[index].excerpt || "").length > 0
                            }
                            text: {
                                var sources = root.parseSources()
                                return index < sources.length ? (sources[index].excerpt || "") : ""
                            }
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            color: SpellUI.SpellTheme.textSecondary
                            wrapMode: Text.Wrap
                            maximumLineCount: 2
                            elide: Text.ElideRight
                        }
                    }

                    SpellUI.StateLayer {
                        onClicked: {
                            var sources = root.parseSources()
                            if (index < sources.length) {
                                root.viewInTab("", sources[index].url || "", sources[index].title || "")
                            }
                        }
                    }
                }
            }

            Text {
                visible: root.parseSources().length === 0
                text: "No results"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                color: SpellUI.SpellTheme.textTertiary
            }
        }
    }
}
