import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "findingCard"

    required property string url
    required property string title
    required property string excerpt
    required property string tagsText
    required property string tabId
    property bool showSeparator: false

    signal viewInTab(string tabId, string url, string title)

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    function domainLabel() {
        var raw = String(root.url || "")
        var match = raw.match(/^[a-z]+:\/\/([^/]+)/i)
        var host = match ? match[1] : raw
        return host.replace(/^www\./, "")
    }

    function tagList() {
        var raw = String(root.tagsText || "")
        if (raw.length === 0) return []
        var parts = raw.split("\n")
        var tags = []
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].length > 0) tags.push(parts[i])
        }
        return tags
    }

    function tagCount() {
        return root.tagList().length
    }

    function tagAt(index) {
        var tags = root.tagList()
        return index >= 0 && index < tags.length ? tags[index] : ""
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
            implicitHeight: cardColumn.implicitHeight + SpellUI.SpellTheme.spacingM * 2
            color: SpellUI.SpellTheme.surface0

            ColumnLayout {
                id: cardColumn
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                RowLayout {
                    Layout.fillWidth: true
                    spacing: SpellUI.SpellTheme.spacingS

                    Rectangle {
                        Layout.preferredWidth: 10
                        Layout.preferredHeight: 10
                        radius: 5
                        color: SpellUI.SpellTheme.textTertiary
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.domainLabel()
                        font.family: SpellUI.SpellTheme.monoFontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textTertiary
                        elide: Text.ElideRight
                    }
                }

                Text {
                    Layout.fillWidth: true
                    text: root.title
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    color: SpellUI.SpellTheme.textPrimary
                    wrapMode: Text.Wrap
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.excerpt.length > 0
                    text: root.excerpt
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                    wrapMode: Text.Wrap
                    maximumLineCount: 3
                    elide: Text.ElideRight
                }

                Row {
                    visible: root.tagCount() > 0
                    spacing: SpellUI.SpellTheme.spacingXS

                    Repeater {
                        model: root.tagCount()

                        delegate: Rectangle {
                            implicitWidth: tagText.implicitWidth + SpellUI.SpellTheme.spacingM
                            implicitHeight: tagText.implicitHeight + SpellUI.SpellTheme.spacingXS
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            color: SpellUI.SpellTheme.surface1

                            Text {
                                id: tagText
                                anchors.centerIn: parent
                                text: root.tagAt(index)
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                color: SpellUI.SpellTheme.textTertiary
                            }
                        }
                    }
                }

                Rectangle {
                    objectName: "viewInTabButton"
                    visible: root.tabId.length > 0
                    implicitWidth: buttonText.implicitWidth + SpellUI.SpellTheme.spacingL
                    implicitHeight: buttonText.implicitHeight + SpellUI.SpellTheme.spacingS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.surface1
                    border.width: 1
                    border.color: SpellUI.SpellTheme.borderSubtle

                    Text {
                        id: buttonText
                        anchors.centerIn: parent
                        text: "View in tab"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textPrimary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.viewInTab(root.tabId, root.url, root.title)
                    }
                }
            }
        }
    }
}
