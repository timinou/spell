import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: root
    objectName: "findingsPanel"

    property string sortMode: "time"
    property string filterTag: ""
    property string viewMode: "curated"

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

    function normalizeUrl(url) {
        var raw = String(url || "")
        if (raw.length === 0) return ""
        // Regex-based URL parsing (no URL constructor in Qt JS)
        var match = raw.match(/^([a-z][a-z0-9+.-]*:\/\/)(?:www\.)?([^/?#]+)(\/?[^?#]*)?(\?[^#]*)?/i)
        if (!match) return raw.toLowerCase()
        var scheme = match[1].toLowerCase()
        var host = match[2].toLowerCase()
        var path = match[3] || ""
        var query = match[4] || ""
        // Strip trailing slash from path only
        if (path.length > 1 && path.charAt(path.length - 1) === "/") {
            path = path.substring(0, path.length - 1)
        }
        return scheme + host + path + query
    }

    function sourceTypeIcon(st) {
        if (st === "search") return "\uD83D\uDD0D"
        if (st === "fetch") return "\uD83D\uDCC4"
        if (st === "code_search") return "\uD83D\uDCBB"
        if (st === "browser") return "\uD83C\uDF10"
        if (st === "agent") return "\u2728"
        return ""
    }

    function findingCount() {
        return findingsModel.count
    }

    function displayCount() {
        return displayModel.count
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
            // Curated filter
            if (root.viewMode === "curated" && item.curated !== "true") {
                continue
            }
            // Tag filter
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
                sourceType: item.sourceType,
                curated: item.curated,
                enriched: item.enriched,
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

    function setViewMode(mode) {
        root.viewMode = mode
        rebuildDisplayModel()
    }

    function handleMessage(payload) {
        if (!payload || payload.type !== "finding") return
        var normalizedUrl = normalizeUrl(payload.url)
        // Check for existing entry by normalized URL
        if (normalizedUrl.length > 0) {
            for (var i = 0; i < findingsModel.count; i++) {
                var existing = findingsModel.get(i)
                if (normalizeUrl(existing.url) === normalizedUrl) {
                    // Merge/enrich: update excerpt if new one is longer
                    var newExcerpt = String(payload.excerpt || "")
                    if (newExcerpt.length > String(existing.excerpt).length) {
                        findingsModel.setProperty(i, "excerpt", newExcerpt)
                    }
                    // Tags union
                    var existingTags = tagList(existing.tagsText)
                    var newTags = tagsTextFromPayload(payload).split("\n")
                    var merged = existingTags.slice()
                    for (var t = 0; t < newTags.length; t++) {
                        if (newTags[t].length > 0 && merged.indexOf(newTags[t]) < 0) {
                            merged.push(newTags[t])
                        }
                    }
                    findingsModel.setProperty(i, "tagsText", merged.join("\n"))
                    // Mark enriched
                    findingsModel.setProperty(i, "enriched", "true")
                    // Promote to curated if incoming is curated
                    if (payload.curated) {
                        findingsModel.setProperty(i, "curated", "true")
                    }
                    rebuildDisplayModel()
                    return
                }
            }
        }
        // New finding: append
        findingsModel.append({
            id: String(payload.id || "finding-" + Date.now()),
            url: String(payload.url || ""),
            title: String(payload.title || payload.url || "Finding"),
            excerpt: String(payload.excerpt || ""),
            tagsText: tagsTextFromPayload(payload),
            domain: domainFromUrl(payload.url),
            tabId: String(payload.tabId || ""),
            timestamp: Number(payload.timestamp || Date.now()),
            sourceType: String(payload.sourceType || "agent"),
            curated: payload.curated === false || payload.curated === "false" ? "false" : "true",
            enriched: payload.enriched ? "true" : "false"
        })
        // Cap at 200 entries
        while (findingsModel.count > 200) findingsModel.remove(0)
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

                // View mode toggle: Curated / All
                Rectangle {
                    implicitWidth: curatedText.implicitWidth + SpellUI.SpellTheme.spacingM
                    implicitHeight: curatedText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: root.viewMode === "curated" ? SpellUI.SpellTheme.surface1 : "transparent"
                    border.width: root.viewMode === "curated" ? 1 : 0
                    border.color: SpellUI.SpellTheme.borderSubtle

                    Text {
                        id: curatedText
                        anchors.centerIn: parent
                        text: "Curated"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: root.viewMode === "curated" ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textTertiary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.setViewMode("curated")
                    }
                }

                Rectangle {
                    implicitWidth: allViewText.implicitWidth + SpellUI.SpellTheme.spacingM
                    implicitHeight: allViewText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: root.viewMode === "all" ? SpellUI.SpellTheme.surface1 : "transparent"
                    border.width: root.viewMode === "all" ? 1 : 0
                    border.color: SpellUI.SpellTheme.borderSubtle

                    Text {
                        id: allViewText
                        anchors.centerIn: parent
                        text: "All"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: root.viewMode === "all" ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textTertiary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.setViewMode("all")
                    }
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
                    required property string sourceType
                    required property string curated
                    required property string enriched

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

                            RowLayout {
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
                                    visible: enriched === "true"
                                    text: "enriched"
                                    font.family: SpellUI.SpellTheme.monoFontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                                    color: SpellUI.SpellTheme.accent
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: SpellUI.SpellTheme.spacingXS

                                Text {
                                    visible: root.sourceTypeIcon(sourceType).length > 0
                                    text: root.sourceTypeIcon(sourceType)
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: domain
                                    font.family: SpellUI.SpellTheme.monoFontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                    color: SpellUI.SpellTheme.textTertiary
                                    elide: Text.ElideRight
                                }
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
                    text: findingsModel.count === 0 ? "No findings yet" : (displayModel.count === 0 && root.viewMode === "curated" ? "No curated findings. Switch to All to see auto-generated findings." : "No findings match")
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textTertiary
                }
            }
        }
    }
}
