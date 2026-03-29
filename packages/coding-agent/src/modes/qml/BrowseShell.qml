import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import QtCore
import "." as SpellUI
import "BrowseContentStore.js" as ContentStore

ApplicationWindow {
    id: root

    visible: true
    width: 1360
    height: 900
    title: "Spell Browse"
    color: SpellUI.SpellTheme.background

    property string activeBrowserTabId: ""
    property string agentStatus: "idle"
    property string statusText: "Ready"
    property int tokenCount: 0
    property bool findingsDrawerOpen: false
    property bool servicesDrawerOpen: false
    property int findingsCount: 0
    property bool restoringTabs: false
    property string browseSettingsCategory: resolvedBrowseSettingsCategory()
    property string browseSettingsFile: resolvedBrowseSettingsFile()
    property var pendingChatMessages: []
    property var pendingBrowserMessages: []
    property var pendingFindingsMessages: []

    function bridgeProp(name, fallback) {
        if (typeof bridge === "undefined" || !bridge || !bridge.props) return fallback
        return bridge.props[name] !== undefined && bridge.props[name] !== null ? bridge.props[name] : fallback
    }

    function resolvedBrowseSettingsCategory() {
        var explicit = String(bridgeProp("settingsCategory", "")).trim()
        if (explicit.length > 0) return explicit
        return "SpellBrowse"
    }

    function resolvedBrowseSettingsFile() {
        var explicit = String(bridgeProp("settingsFile", "")).trim()
        if (explicit.length > 0) return explicit
        var configRoot = String(StandardPaths.writableLocation(StandardPaths.AppConfigLocation) || "").trim()
        if (configRoot.length === 0) {
            configRoot = String(StandardPaths.writableLocation(StandardPaths.HomeLocation) || "").trim()
        }
        if (configRoot.length === 0) {
            configRoot = "/tmp"
        }
        return configRoot + "/spell-browse.ini"
    }

    Settings {
        id: browseSettings
        location: root.browseSettingsFile.indexOf("/") === 0 ? "file://" + root.browseSettingsFile : Qt.resolvedUrl(root.browseSettingsFile)
        category: root.browseSettingsCategory
        property string tabsJson: "[]"
        property string activeTabId: ""
        property string findingsJson: "[]"
    }

    ListModel {
        id: browserTabsModel
    }

    function activeTabId() {
        return activeBrowserTabId.length > 0 ? activeBrowserTabId : "chat"
    }

    function activeTabType() {
        if (activeBrowserTabId.length === 0) return "chat"
        var index = findBrowserTabIndexById(activeBrowserTabId)
        if (index < 0) return "browser"
        return String(browserTabsModel.get(index).tabType || "browser")
    }

    function findBrowserTabIndexById(tabId) {
        if (!tabId) return -1
        for (var i = 0; i < browserTabsModel.count; i++) {
            if (browserTabsModel.get(i).tabId === tabId) return i
        }
        return -1
    }

    function browserTabCount() {
        return browserTabsModel.count
    }

    function getBrowserPanelItem() {
        return browserPanelLoader.item
    }

    function getFindingsPanelItem() {
        return findingsPanelLoader.item
    }

    function toggleFindingsDrawer() {
        findingsDrawerOpen = !findingsDrawerOpen
    }

    function browserTabsSnapshot() {
        var tabs = []
        for (var i = 0; i < browserTabsModel.count; i++) {
            var tab = browserTabsModel.get(i)
            tabs.push({
                tabId: String(tab.tabId || ("restored-" + i)),
                title: String(tab.title || "Browser"),
                url: String(tab.url || "about:blank"),
                tabType: String(tab.tabType || "browser")
            })
        }
        return tabs
    }

    function parseRestoreTabs(value) {
        var raw = value
        if (typeof raw === "string") {
            try {
                raw = JSON.parse(raw)
            } catch (_error) {
                return []
            }
        }
        if (!raw || raw.length === undefined) return []
        var tabs = []
        for (var i = 0; i < raw.length; i++) {
            var entry = raw[i]
            if (!entry || typeof entry !== "object") continue
            tabs.push({
                tabId: String(entry.tabId || ("restored-" + i)),
                title: String(entry.title || "Browser"),
                url: String(entry.url || "about:blank"),
                tabType: String(entry.tabType || "browser")
            })
        }
        return tabs
    }

    function persistTabState() {
        if (restoringTabs) return
        browseSettings.tabsJson = JSON.stringify(browserTabsSnapshot())
        browseSettings.activeTabId = activeBrowserTabId
    }

    function persistFindings() {
        var panel = getFindingsPanelItem()
        if (!panel || !panel.findingsModel) return
        var entries = []
        for (var i = 0; i < panel.findingsModel.count && i < 200; i++) {
            var item = panel.findingsModel.get(i)
            entries.push({
                id: String(item.id || ""),
                url: String(item.url || ""),
                title: String(item.title || ""),
                excerpt: String(item.excerpt || ""),
                tagsText: String(item.tagsText || ""),
                tabId: String(item.tabId || ""),
                timestamp: Number(item.timestamp || 0),
                sourceType: String(item.sourceType || "agent"),
                curated: String(item.curated || "false"),
                enriched: String(item.enriched || "false")
            })
        }
        browseSettings.findingsJson = JSON.stringify(entries)
    }

    function restoreFindingsFromState() {
        var raw = browseSettings.findingsJson
        if (typeof raw !== "string" || raw.length < 3) return
        try {
            var entries = JSON.parse(raw)
            if (!entries || entries.length === undefined) return
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i]
                if (!entry || typeof entry !== "object") continue
                var tagsRaw = String(entry.tagsText || "").split("\n")
                var tagsClean = []
                for (var t = 0; t < tagsRaw.length; t++) {
                    if (tagsRaw[t].length > 0) tagsClean.push(tagsRaw[t])
                }
                forwardToFindingsPanel({
                    type: "finding",
                    id: entry.id || "",
                    url: entry.url || "",
                    title: entry.title || "",
                    excerpt: entry.excerpt || "",
                    tags: tagsClean,
                    tabId: entry.tabId || "",
                    timestamp: entry.timestamp || 0,
                    sourceType: entry.sourceType || "agent",
                    curated: entry.curated === "true",
                    enriched: entry.enriched === "true"
                })
            }
            Qt.callLater(function() {
                var panel = getFindingsPanelItem()
                if (panel) findingsCount = panel.findingCount()
            })
        } catch (e) {
            // Silently ignore corrupt settings
        }
    }

    function restoreTabsFromState() {
        restoringTabs = true
        browserTabsModel.clear()
        activeBrowserTabId = ""

        var restoredTabs = parseRestoreTabs(bridgeProp("restoreTabs", null))
        if (restoredTabs.length === 0) {
            restoredTabs = parseRestoreTabs(browseSettings.tabsJson)
        }

        for (var i = 0; i < restoredTabs.length; i++) {
            var tab = restoredTabs[i]
            upsertBrowserTab(tab.tabId, tab.title, tab.url, false, tab.tabType)
            forwardToBrowserPanel({ action: "tab:open", tabId: tab.tabId, title: tab.title, url: tab.url })
        }

        var nextActive = String(bridgeProp("restoreActiveTabId", browseSettings.activeTabId) || "")
        if (nextActive.length > 0 && findBrowserTabIndexById(nextActive) >= 0) {
            activeBrowserTabId = nextActive
            forwardToBrowserPanel({ action: "tab:switch", tabId: nextActive })
        }

        restoringTabs = false
        persistTabState()
    }

    function setActiveTab(tabId) {
        activeBrowserTabId = tabId && tabId !== "chat" ? tabId : ""
        persistTabState()
    }

    function upsertBrowserTab(tabId, title, url, activate, tabType) {
        if (!tabId) return
        var index = findBrowserTabIndexById(tabId)
        var resolvedTabType = tabType || "browser"
        var tab = {
            tabId: tabId,
            title: title && title.length > 0 ? title : "Browser",
            url: url || "about:blank",
            tabType: resolvedTabType
        }
        if (index >= 0) {
            browserTabsModel.set(index, tab)
        } else {
            browserTabsModel.append(tab)
        }
        if (activate !== false) {
            setActiveTab(tabId)
        } else {
            persistTabState()
        }
    }

    function removeBrowserTab(tabId) {
        var index = findBrowserTabIndexById(tabId)
        if (index < 0) return
        browserTabsModel.remove(index)
        ContentStore.remove(tabId)
        if (activeBrowserTabId === tabId) {
            if (browserTabsModel.count === 0) {
                activeBrowserTabId = ""
            } else {
                var nextIndex = Math.min(index, browserTabsModel.count - 1)
                activeBrowserTabId = String(browserTabsModel.get(nextIndex).tabId)
            }
        }
        persistTabState()
    }

    function updateBrowserTabFromPayload(payload) {
        var tabId = String(payload.tabId || "")
        if (tabId.length === 0) return
        var index = findBrowserTabIndexById(tabId)
        if (index < 0) return
        var current = browserTabsModel.get(index)
        browserTabsModel.set(index, {
            tabId: current.tabId,
            title: payload.title !== undefined && String(payload.title).length > 0 ? String(payload.title) : current.title,
            url: payload.url !== undefined && String(payload.url).length > 0 ? String(payload.url) : current.url,
            tabType: current.tabType || "browser"
        })
        persistTabState()
    }

    function statusColor(status) {
        if (status === "busy") return SpellUI.SpellTheme.success
        if (status === "blocked") return SpellUI.SpellTheme.warning
        if (status === "error") return SpellUI.SpellTheme.error
        return SpellUI.SpellTheme.textTertiary
    }

    function updateStatusFromDashboard(payload) {
        if (payload.agent && typeof payload.agent === "object") {
            var nextStatus = String(payload.agent.status || "idle")
            var elapsed = String(payload.agent.elapsed || "")
            agentStatus = nextStatus
            if (nextStatus === "busy") {
                statusText = elapsed.length > 0 ? "Working · " + elapsed : "Working"
            } else if (nextStatus === "blocked") {
                statusText = "Blocked"
            } else if (nextStatus === "error") {
                statusText = "Error"
            } else {
                statusText = "Ready"
            }
        }
        if (payload.tokens !== undefined) {
            tokenCount = Number(payload.tokens) || 0
        }
    }

    function flushPendingChat() {
        var item = chatLoader.item
        if (!item || typeof item.handleMessage !== "function") return
        var queued = pendingChatMessages
        pendingChatMessages = []
        for (var i = 0; i < queued.length; i++) {
            item.handleMessage(queued[i])
        }
    }

    function flushPendingBrowserPanel() {
        var item = getBrowserPanelItem()
        if (!item || typeof item.handleMessage !== "function") return
        var queued = pendingBrowserMessages
        pendingBrowserMessages = []
        for (var i = 0; i < queued.length; i++) {
            item.handleMessage(queued[i])
        }
    }

    function flushPendingFindingsPanel() {
        var item = getFindingsPanelItem()
        if (!item || typeof item.handleMessage !== "function") return
        var queued = pendingFindingsMessages
        pendingFindingsMessages = []
        for (var i = 0; i < queued.length; i++) {
            item.handleMessage(queued[i])
        }
    }

    function forwardToChat(payload) {
        var item = chatLoader.item
        if (item && typeof item.handleMessage === "function") {
            item.handleMessage(payload)
            return
        }
        pendingChatMessages = pendingChatMessages.concat([payload])
    }

    function forwardToBrowserPanel(payload) {
        var item = getBrowserPanelItem()
        if (item && typeof item.handleMessage === "function") {
            item.handleMessage(payload)
            return
        }
        pendingBrowserMessages = pendingBrowserMessages.concat([payload])
    }

    function forwardToFindingsPanel(payload) {
        var item = getFindingsPanelItem()
        if (item && typeof item.handleMessage === "function") {
            item.handleMessage(payload)
            return
        }
        pendingFindingsMessages = pendingFindingsMessages.concat([payload])
    }

    function isBrowserProtocolPayload(payload) {
        if (!payload || typeof payload !== "object" || !payload.action) return false
        var action = String(payload.action)
        return action.indexOf("browser:") === 0 || action.indexOf("tab:") === 0
    }

    function handleBridgeMessage(payload) {
        if (!payload || typeof payload !== "object") {
            forwardToChat(payload)
            return
        }

        if (payload.type === "dashboard_update") {
            updateStatusFromDashboard(payload)
            return
        }

        if (payload.type === "finding") {
            forwardToFindingsPanel(payload)
            Qt.callLater(function() {
                var panel = getFindingsPanelItem()
                if (panel) findingsCount = panel.findingCount()
            })
            forwardToChat(payload)
            persistFindings()
            return
        }

        if (payload.type === "findings_batch") {
            var findings = payload.findings || []
            for (var i = 0; i < findings.length; i++) {
                var f = findings[i]
                forwardToFindingsPanel({
                    type: "finding",
                    id: f.id || "",
                    url: f.url || "",
                    title: f.title || "",
                    excerpt: f.excerpt || "",
                    tags: f.tags || [],
                    tabId: f.tabId || "",
                    timestamp: f.timestamp || Date.now(),
                    sourceType: f.sourceType || "search",
                    curated: !!f.curated,
                    enriched: !!f.enriched
                })
                if (f.contentBody && f.contentBody.length > 0 && f.url) {
                    ContentStore.set(f.url, f.contentBody)
                }
            }
            Qt.callLater(function() {
                var panel = getFindingsPanelItem()
                if (panel) findingsCount = panel.findingCount()
            })
            forwardToChat(payload)
            persistFindings()
            return
        }

        if (payload.action === "service_list_update" && payload.services) {
            if (servicesPanelLoader.item && typeof servicesPanelLoader.item.updateServices === "function") {
                servicesPanelLoader.item.updateServices(payload.services)
            }
            return
        }


        if (payload.action === "browser:url_changed" || payload.action === "browser:result" || payload.action === "browser:navigation_failed") {
            updateBrowserTabFromPayload(payload)
        }

        if (payload.action === "tab:open") {
            var content = ContentStore.get(String(payload.url || ""))
            var resolvedTabType = content ? "document" : "browser"
            upsertBrowserTab(String(payload.tabId || ""), String(payload.title || ""), String(payload.url || ""), true, resolvedTabType)
            if (resolvedTabType === "document") {
                ContentStore.set(String(payload.tabId), content)
                if (contentViewerLoader.item) {
                    contentViewerLoader.item.loadContent(payload.url, payload.title, content)
                }
            } else {
                forwardToBrowserPanel(payload)
            }
            return
        }

        if (payload.action === "tab:close") {
            removeBrowserTab(String(payload.tabId || ""))
            forwardToBrowserPanel(payload)
            return
        }

        if (payload.action === "tab:switch") {
            setActiveTab(String(payload.tabId || "chat"))
            forwardToBrowserPanel(payload)
            return
        }

        if (isBrowserProtocolPayload(payload)) {
            forwardToBrowserPanel(payload)
            return
        }

        forwardToChat(payload)
    }

    onActiveBrowserTabIdChanged: {
        var browserPanel = getBrowserPanelItem()
        if (browserPanel && typeof browserPanel.focusTab === "function") {
            browserPanel.focusTab(activeBrowserTabId)
        }
        if (root.activeTabType() === "document" && contentViewerLoader.item) {
            var content = ContentStore.get(activeBrowserTabId)
            var tabIndex = findBrowserTabIndexById(activeBrowserTabId)
            var tabUrl = ""
            var tabTitle = ""
            if (tabIndex >= 0) {
                tabUrl = String(browserTabsModel.get(tabIndex).url || "")
                tabTitle = String(browserTabsModel.get(tabIndex).title || "")
            }
            contentViewerLoader.item.loadContent(tabUrl, tabTitle, content || "")
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingS

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 52
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            RowLayout {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: "Spell"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                    color: SpellUI.SpellTheme.textPrimary
                    Layout.leftMargin: SpellUI.SpellTheme.spacingS
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    color: "transparent"
                    clip: true

                    Flickable {
                        anchors.fill: parent
                        contentWidth: tabsRow.implicitWidth
                        contentHeight: height
                        boundsBehavior: Flickable.StopAtBounds
                        flickableDirection: Flickable.HorizontalFlick
                        clip: true
                        interactive: contentWidth > width

                        Row {
                            id: tabsRow
                            spacing: SpellUI.SpellTheme.spacingXS
                            anchors.verticalCenter: parent.verticalCenter

                            Rectangle {
                                objectName: "browseTab-chat"
                                width: Math.max(72, chatTabLabel.implicitWidth + SpellUI.SpellTheme.spacingL * 2)
                                height: 32
                                radius: SpellUI.SpellTheme.cornerRadiusSmall
                                color: root.activeTabId() === "chat"
                                    ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.16)
                                    : "transparent"
                                border.width: root.activeTabId() === "chat" ? 1 : 0
                                border.color: SpellUI.SpellTheme.borderSubtle

                                Text {
                                    id: chatTabLabel
                                    anchors.centerIn: parent
                                    text: "Chat"
                                    font.family: SpellUI.SpellTheme.fontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                    font.weight: root.activeTabId() === "chat"
                                        ? SpellUI.SpellTheme.fontWeightMedium
                                        : SpellUI.SpellTheme.fontWeightRegular
                                    color: root.activeTabId() === "chat"
                                        ? SpellUI.SpellTheme.textPrimary
                                        : SpellUI.SpellTheme.textSecondary
                                }

                                SpellUI.StateLayer {
                                    onClicked: root.setActiveTab("chat")
                                }
                            }

                            Repeater {
                                model: browserTabsModel

                                delegate: Rectangle {
                                    objectName: "browseTab-" + tabId
                                    required property string tabId
                                    required property string title
                                    required property string url
                                    required property string tabType

                                    width: Math.max(88, tabLabel.implicitWidth + SpellUI.SpellTheme.spacingL * 2)
                                    height: 32
                                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                                    color: root.activeTabId() === tabId
                                        ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.16)
                                        : "transparent"
                                    border.width: root.activeTabId() === tabId ? 1 : 0
                                    border.color: SpellUI.SpellTheme.borderSubtle

                                    Text {
                                        id: tabLabel
                                        anchors.centerIn: parent
                                        text: (tabType === "document" ? "\uD83D\uDCC4 " : "") + (title || "Browser")
                                        font.family: SpellUI.SpellTheme.fontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                        font.weight: root.activeTabId() === tabId
                                            ? SpellUI.SpellTheme.fontWeightMedium
                                            : SpellUI.SpellTheme.fontWeightRegular
                                        color: root.activeTabId() === tabId
                                            ? SpellUI.SpellTheme.textPrimary
                                            : SpellUI.SpellTheme.textSecondary
                                        elide: Text.ElideRight
                                    }

                                    SpellUI.StateLayer {
                                        onClicked: root.setActiveTab(tabId)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.background
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle
            clip: true

            Loader {
                id: chatLoader
                anchors.fill: parent
                active: true
                visible: root.activeTabId() === "chat"
                source: Qt.resolvedUrl("panels/BrowseChatPanel.qml")
                onLoaded: root.flushPendingChat()
            }

            Loader {
                id: browserPanelLoader
                anchors.fill: parent
                active: true
                visible: root.activeTabId() !== "chat" && root.activeTabType() !== "document"
                source: Qt.resolvedUrl("panels/BrowserPanel.qml")
                onLoaded: {
                    if (item && typeof item.focusTab === "function") {
                        item.focusTab(root.activeBrowserTabId)
                    }
                    root.flushPendingBrowserPanel()
                }
            }

            Loader {
                id: contentViewerLoader
                anchors.fill: parent
                active: true
                visible: root.activeTabType() === "document"
                source: Qt.resolvedUrl("panels/ContentViewerPanel.qml")
                onLoaded: {
                    if (item) {
                        item.viewInBrowser.connect(function(url, title) {
                            var newTabId = "browser-" + Date.now()
                            upsertBrowserTab(newTabId, title, url, true, "browser")
                            forwardToBrowserPanel({ action: "tab:open", tabId: newTabId, title: title, url: url })
                        })
                    }
                }
            }
        }

        Item {
            Layout.fillWidth: true
            implicitHeight: root.findingsDrawerOpen ? 260 : 0
            clip: true

            Behavior on implicitHeight {
                NumberAnimation {
                    duration: SpellUI.SpellTheme.durationMedium
                    easing.type: Easing.OutQuad
                }
            }

            Loader {
                id: findingsPanelLoader
                anchors.fill: parent
                active: true
                visible: parent.implicitHeight > 0
                source: Qt.resolvedUrl("panels/FindingsPanel.qml")
                onLoaded: root.flushPendingFindingsPanel()
            }
        }

        Item {
            Layout.fillWidth: true
            implicitHeight: root.servicesDrawerOpen ? 220 : 0
            clip: true

            Behavior on implicitHeight {
                NumberAnimation {
                    duration: SpellUI.SpellTheme.durationMedium
                    easing.type: Easing.OutQuad
                }
            }

            Loader {
                id: servicesPanelLoader
                anchors.fill: parent
                active: true
                visible: parent.implicitHeight > 0
                source: Qt.resolvedUrl("panels/ServicesPanel.qml")
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: footerRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle

            RowLayout {
                id: footerRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle {
                    Layout.preferredWidth: 10
                    Layout.preferredHeight: 10
                    radius: 5
                    color: root.statusColor(root.agentStatus)
                }

                Text {
                    text: root.statusText
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }

                Rectangle {
                    objectName: "findingsToggleButton"
                    implicitWidth: findingsToggleText.implicitWidth + SpellUI.SpellTheme.spacingL
                    implicitHeight: findingsToggleText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: root.findingsDrawerOpen ? SpellUI.SpellTheme.surface1 : "transparent"
                    border.width: 1
                    border.color: SpellUI.SpellTheme.borderSubtle

                    Text {
                        id: findingsToggleText
                        anchors.centerIn: parent
                        text: root.findingsCount > 0 ? "Findings (" + root.findingsCount + ")" : "Findings"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textSecondary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.toggleFindingsDrawer()
                    }
                }

                Rectangle {
                    objectName: "servicesToggleButton"
                    implicitWidth: servicesToggleText.implicitWidth + SpellUI.SpellTheme.spacingL
                    implicitHeight: servicesToggleText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: root.servicesDrawerOpen ? SpellUI.SpellTheme.surface1 : "transparent"
                    border.width: 1
                    border.color: SpellUI.SpellTheme.borderSubtle

                    Text {
                        id: servicesToggleText
                        anchors.centerIn: parent
                        text: {
                            if (!servicesPanelLoader.item) return "Services"
                            var total = servicesPanelLoader.item.totalCount
                            if (total > 0) return "Services (" + servicesPanelLoader.item.connectedCount + "/" + total + ")"
                            return "Services"
                        }
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textSecondary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.servicesDrawerOpen = !root.servicesDrawerOpen
                    }
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: bridge.props.model || ""
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                    elide: Text.ElideRight
                    Layout.maximumWidth: 360
                }

                Text {
                    text: root.tokenCount > 0 ? root.tokenCount + " tokens" : ""
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }
            }
        }
    }

    Component.onCompleted: {
        restoreTabsFromState()
        restoreFindingsFromState()
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            root.handleBridgeMessage(payload)
        }
    }
}
