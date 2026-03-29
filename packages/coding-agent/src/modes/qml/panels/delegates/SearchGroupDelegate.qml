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
    property var cachedSources: []

    signal viewInTab(string tabId, string url, string title)
    signal toggleCollapsed(int index)

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    onSourcesJsonChanged: updateCachedSources()
    Component.onCompleted: updateCachedSources()

    function updateCachedSources() {
        try {
            cachedSources = JSON.parse(root.sourcesJson)
        } catch (e) {
            cachedSources = []
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
                        text: String(root.cachedSources.length)
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
                model: Math.min(root.cachedSources.length, 3)

                delegate: Text {
                    required property int index
                    Layout.fillWidth: true
                    text: {
                        if (index < root.cachedSources.length) {
                            var s = root.cachedSources[index]
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
                model: root.collapsed !== "true" ? root.cachedSources.length : 0

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
                                    if (index < root.cachedSources.length) return root.sourceTypeIcon(root.cachedSources[index].sourceType || "search")
                                    return ""
                                }
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            }

                            Text {
                                Layout.fillWidth: true
                                text: {
                                    if (index < root.cachedSources.length) {
                                        var url = root.cachedSources[index].url || ""
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
                                return index < root.cachedSources.length ? (root.cachedSources[index].title || "") : ""
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
                                return index < root.cachedSources.length && (root.cachedSources[index].excerpt || "").length > 0
                            }
                            text: {
                                return index < root.cachedSources.length ? (root.cachedSources[index].excerpt || "") : ""
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
                            if (index < root.cachedSources.length) {
                                root.viewInTab("", root.cachedSources[index].url || "", root.cachedSources[index].title || "")
                            }
                        }
                    }
                }
            }

            Text {
                visible: root.cachedSources.length === 0
                text: "No results"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                color: SpellUI.SpellTheme.textTertiary
            }
        }
    }
}
