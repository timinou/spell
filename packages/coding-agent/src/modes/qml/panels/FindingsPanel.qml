import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: root
    objectName: "findingsPanel"

    property string sortMode: "time"
    property string filterTag: ""

    readonly property alias findingsModel: findingsModel

    ListModel {
        id: findingsModel
    }

    ListModel {
        id: displayModel
    }

    function tagsTextFromPayload(payload) {
        if (!payload || !payload.tags || payload.tags.length === undefined) return ""
        var parts = []
        for (var i = 0; i < payload.tags.length; i++) {
            var value = String(payload.tags[i] || "")
            if (value.length > 0) parts.push(value)
        }
        return parts.join("\n")
    }

    function tagList(tagsText) {
        var raw = String(tagsText || "")
        if (raw.length === 0) return []
        var parts = raw.split("\n")
        var tags = []
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].length > 0) tags.push(parts[i])
        }
        return tags
    }

    function domainFromUrl(url) {
        var raw = String(url || "")
        var match = raw.match(/^[a-z]+:\/\/([^/]+)/i)
        var host = match ? match[1] : raw
        return host.replace(/^www\./, "")
    }

    function findingCount() {
        return findingsModel.count
    }

    function displayTitleAt(index) {
        if (index < 0 || index >= displayModel.count) return ""
        return String(displayModel.get(index).title || "")
    }

    function availableTags() {
        var unique = {}
        var tags = []
        for (var i = 0; i < findingsModel.count; i++) {
            var findingTags = tagList(findingsModel.get(i).tagsText)
            for (var j = 0; j < findingTags.length; j++) {
                var tag = findingTags[j]
                if (!unique[tag]) {
                    unique[tag] = true
                    tags.push(tag)
                }
            }
        }
        tags.sort()
        return tags
    }

    function rebuildDisplayModel() {
        var entries = []
        for (var i = 0; i < findingsModel.count; i++) {
            var item = findingsModel.get(i)
            if (root.filterTag.length > 0 && tagList(item.tagsText).indexOf(root.filterTag) < 0) {
                continue
            }
            entries.push({
                id: item.id,
                url: item.url,
                title: item.title,
                excerpt: item.excerpt,
                tagsText: item.tagsText,
                domain: item.domain,
                tabId: item.tabId,
                timestamp: item.timestamp,
                expanded: false
            })
        }

        entries.sort(function(a, b) {
            if (root.sortMode === "domain") {
                return String(a.domain).localeCompare(String(b.domain)) || String(a.title).localeCompare(String(b.title))
            }
            if (root.sortMode === "tags") {
                return String(a.tagsText).localeCompare(String(b.tagsText)) || String(a.title).localeCompare(String(b.title))
            }
            return Number(b.timestamp) - Number(a.timestamp)
        })

        displayModel.clear()
        for (var j = 0; j < entries.length; j++) {
            displayModel.append(entries[j])
        }
    }

    function setSortMode(mode) {
        root.sortMode = mode
        rebuildDisplayModel()
    }

    function setFilterTag(tag) {
        root.filterTag = tag || ""
        rebuildDisplayModel()
    }

    function handleMessage(payload) {
        if (!payload || payload.type !== "finding") return
        findingsModel.append({
            id: String(payload.id || "finding-" + Date.now()),
            url: String(payload.url || ""),
            title: String(payload.title || payload.url || "Finding"),
            excerpt: String(payload.excerpt || ""),
            tagsText: tagsTextFromPayload(payload),
            domain: domainFromUrl(payload.url),
            tabId: String(payload.tabId || ""),
            timestamp: Number(payload.timestamp || Date.now())
        })
        rebuildDisplayModel()
    }

    Rectangle {
        anchors.fill: parent
        radius: SpellUI.SpellTheme.cornerRadiusSmall
        color: SpellUI.SpellTheme.surface0
        border.width: 1
        border.color: SpellUI.SpellTheme.borderSubtle

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: SpellUI.SpellTheme.spacingM
            spacing: SpellUI.SpellTheme.spacingS

            RowLayout {
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: "Findings"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    color: SpellUI.SpellTheme.textPrimary
                }

                Text {
                    text: root.findingCount() > 0 ? String(root.findingCount()) : ""
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textTertiary
                }

                Item { Layout.fillWidth: true }

                Repeater {
                    model: [
                        { label: "Time", value: "time" },
                        { label: "Domain", value: "domain" },
                        { label: "Tags", value: "tags" }
                    ]

                    delegate: Rectangle {
                        required property var modelData

                        implicitWidth: modeText.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: modeText.implicitHeight + SpellUI.SpellTheme.spacingXS
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: root.sortMode === modelData.value ? SpellUI.SpellTheme.surface1 : "transparent"
                        border.width: root.sortMode === modelData.value ? 1 : 0
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: modeText
                            anchors.centerIn: parent
                            text: modelData.label
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            color: root.sortMode === modelData.value ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textTertiary
                        }

                        SpellUI.StateLayer {
                            onClicked: root.setSortMode(modelData.value)
                        }
                    }
                }
            }

            Flickable {
                Layout.fillWidth: true
                Layout.preferredHeight: tagRow.implicitHeight
                contentWidth: tagRow.implicitWidth
                contentHeight: tagRow.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.HorizontalFlick
                interactive: contentWidth > width
                visible: tagRow.children.length > 0

                Row {
                    id: tagRow
                    spacing: SpellUI.SpellTheme.spacingXS

                    Rectangle {
                        implicitWidth: allTagsText.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: allTagsText.implicitHeight + SpellUI.SpellTheme.spacingXS
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: root.filterTag.length === 0 ? SpellUI.SpellTheme.surface1 : "transparent"
                        border.width: root.filterTag.length === 0 ? 1 : 0
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: allTagsText
                            anchors.centerIn: parent
                            text: "All"
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            color: root.filterTag.length === 0 ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textTertiary
                        }

                        SpellUI.StateLayer {
                            onClicked: root.setFilterTag("")
                        }
                    }

                    Repeater {
                        model: root.availableTags()

                        delegate: Rectangle {
                            required property string modelData

                            implicitWidth: filterText.implicitWidth + SpellUI.SpellTheme.spacingM
                            implicitHeight: filterText.implicitHeight + SpellUI.SpellTheme.spacingXS
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            color: root.filterTag === modelData ? SpellUI.SpellTheme.surface1 : "transparent"
                            border.width: root.filterTag === modelData ? 1 : 0
                            border.color: SpellUI.SpellTheme.borderSubtle

                            Text {
                                id: filterText
                                anchors.centerIn: parent
                                text: modelData
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                color: root.filterTag === modelData ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textTertiary
                            }

                            SpellUI.StateLayer {
                                onClicked: root.setFilterTag(modelData)
                            }
                        }
                    }
                }
            }

            ListView {
                id: findingsList
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: displayModel
                spacing: SpellUI.SpellTheme.spacingS

                delegate: Rectangle {
                    required property string title
                    required property string url
                    required property string excerpt
                    required property string tagsText
                    required property bool expanded
                    required property int index
                    required property string domain

                    width: ListView.view.width
                    implicitHeight: expanded ? expandedColumn.implicitHeight + SpellUI.SpellTheme.spacingM * 2 : headerColumn.implicitHeight + SpellUI.SpellTheme.spacingM * 2
                    color: "transparent"
                    border.width: 0

                    ColumnLayout {
                        id: expandedColumn
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingM
                        spacing: SpellUI.SpellTheme.spacingXS

                        ColumnLayout {
                            id: headerColumn
                            Layout.fillWidth: true
                            spacing: SpellUI.SpellTheme.spacingXS

                            Text {
                                Layout.fillWidth: true
                                text: title
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                font.weight: SpellUI.SpellTheme.fontWeightMedium
                                color: SpellUI.SpellTheme.textPrimary
                                elide: Text.ElideRight
                            }

                            Text {
                                Layout.fillWidth: true
                                text: domain
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                color: SpellUI.SpellTheme.textTertiary
                                elide: Text.ElideRight
                            }

                            Text {
                                Layout.fillWidth: true
                                visible: tagsText.length > 0
                                text: tagsText.replace(/\n/g, " · ")
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                color: SpellUI.SpellTheme.textTertiary
                                elide: Text.ElideRight
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: expanded && excerpt.length > 0
                            text: excerpt
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            color: SpellUI.SpellTheme.textSecondary
                            wrapMode: Text.Wrap
                        }
                    }

                    Rectangle {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        height: 1
                        color: SpellUI.SpellTheme.borderSubtle
                    }

                    SpellUI.StateLayer {
                        onClicked: displayModel.setProperty(index, "expanded", !expanded)
                    }
                }

                Text {
                    anchors.centerIn: parent
                    visible: findingsModel.count === 0 || displayModel.count === 0
                    text: findingsModel.count === 0 ? "No findings yet" : "No findings match"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textTertiary
                }
            }
        }
    }
}
