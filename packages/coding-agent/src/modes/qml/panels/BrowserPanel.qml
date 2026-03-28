import QtQuick 2.15
import QtWebEngine
import ".." as SpellUI
import "../canvas/components" as CanvasComponents

Item {
    id: root

    property string activeTabId: ""

    readonly property alias tabsModel: tabsModel

    ListModel {
        id: tabsModel
    }

    WebEngineProfilePrototype {
        id: sharedProfilePrototype
        storageName: "spell-browse-mode"
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
    }

    readonly property var sharedProfile: sharedProfilePrototype.instance()

    function getActiveTabId() {
        if (activeTabId.length > 0 && findTabIndexById(activeTabId) >= 0) {
            return activeTabId
        }
        if (tabsModel.count > 0) {
            return tabsModel.get(0).tabId
        }
        return ""
    }

    function findTabIndexById(tabId) {
        if (!tabId) return -1
        for (var i = 0; i < tabsModel.count; i++) {
            if (tabsModel.get(i).tabId === tabId) return i
        }
        return -1
    }

    function tabSummaryAt(index) {
        if (index < 0 || index >= tabsModel.count) return null
        var tab = tabsModel.get(index)
        return {
            tabId: tab.tabId,
            title: tab.title,
            url: tab.url,
            state: tab.state
        }
    }

    function currentTabUrl() {
        var index = findTabIndexById(getActiveTabId())
        var tab = tabSummaryAt(index)
        return tab ? String(tab.url || "") : ""
    }

    function currentTabTitle() {
        var index = findTabIndexById(getActiveTabId())
        var tab = tabSummaryAt(index)
        return tab ? String(tab.title || "") : ""
    }

    function focusTab(tabId) {
        activeTabId = tabId || ""
    }

    function listTabs() {
        var tabs = []
        for (var i = 0; i < tabsModel.count; i++) {
            tabs.push(tabSummaryAt(i))
        }
        return tabs
    }

    function tabBrowserItem(tabId) {
        var index = findTabIndexById(tabId)
        if (index < 0) return null
        var delegate = browserRepeater.itemAt(index)
        return delegate ? delegate.browserItem : null
    }

    function updateTabProperty(tabId, key, value) {
        var index = findTabIndexById(tabId)
        if (index < 0) return
        tabsModel.setProperty(index, key, value)
    }

    function updateTabFromPayload(tabId, payload) {
        if (!tabId || !payload || typeof payload !== "object") return
        if (payload.url !== undefined) updateTabProperty(tabId, "url", String(payload.url || ""))
        if (payload.title !== undefined) updateTabProperty(tabId, "title", String(payload.title || "Browser"))
        if (payload.state !== undefined) updateTabProperty(tabId, "state", String(payload.state || "idle"))
    }

    function emitProtocol(payload) {
        if (typeof bridge !== "undefined" && bridge) {
            bridge.send(payload)
        }
    }

    function browserError(code, message, detail) {
        return {
            code: code,
            message: message,
            detail: detail === undefined ? null : detail
        }
    }

    function emitTabResult(commandPayload, ok, result, error) {
        if (typeof commandPayload._rid !== "string" || commandPayload._rid.length === 0) return
        emitProtocol({
            action: "tab:result",
            _rid: commandPayload._rid,
            command: commandPayload.action,
            ok: ok,
            result: result === undefined ? null : result,
            error: error || null,
            activeTabId: getActiveTabId()
        })
    }

    function emitBrowserErrorResult(commandPayload, tabId, message, detail) {
        if (typeof commandPayload._rid !== "string" || commandPayload._rid.length === 0) return
        emitProtocol({
            action: "browser:result",
            _rid: commandPayload._rid,
            command: commandPayload.action,
            ok: false,
            result: null,
            error: browserError("invalid_tab", message, detail),
            url: tabId ? currentUrlForTab(tabId) : "",
            title: tabId ? currentTitleForTab(tabId) : "",
            state: "error",
            tabId: tabId || ""
        })
    }

    function currentUrlForTab(tabId) {
        var index = findTabIndexById(tabId)
        var tab = tabSummaryAt(index)
        return tab ? String(tab.url || "") : ""
    }

    function currentTitleForTab(tabId) {
        var index = findTabIndexById(tabId)
        var tab = tabSummaryAt(index)
        return tab ? String(tab.title || "") : ""
    }

    function ensureOpenTab(payload) {
        var requestedTabId = String(payload.tabId || "")
        var nextTabId = requestedTabId.length > 0 ? requestedTabId : "tab-" + Date.now() + "-" + tabsModel.count
        var existingIndex = findTabIndexById(nextTabId)
        var nextUrl = payload.url !== undefined ? String(payload.url || "about:blank") : "about:blank"
        var nextTitle = payload.title !== undefined && String(payload.title).length > 0 ? String(payload.title) : "Browser"

        if (existingIndex >= 0) {
            updateTabProperty(nextTabId, "title", nextTitle)
            updateTabProperty(nextTabId, "url", nextUrl)
        } else {
            tabsModel.append({
                tabId: nextTabId,
                title: nextTitle,
                url: nextUrl,
                state: "idle"
            })
        }

        focusTab(nextTabId)
        emitTabResult(payload, true, { tab: tabSummaryAt(findTabIndexById(nextTabId)), tabs: listTabs() }, null)
    }

    function closeTab(payload) {
        var requestedTabId = String(payload.tabId || "")
        var index = findTabIndexById(requestedTabId)
        if (index < 0) {
            emitTabResult(payload, false, null, browserError("invalid_tab", "Tab not found.", { tabId: requestedTabId }))
            return
        }

        tabsModel.remove(index)
        if (activeTabId === requestedTabId) {
            activeTabId = tabsModel.count > 0 ? String(tabsModel.get(Math.max(0, index - 1)).tabId) : ""
        }
        emitTabResult(payload, true, { tabId: requestedTabId, tabs: listTabs() }, null)
    }

    function switchTab(payload) {
        var requestedTabId = String(payload.tabId || "")
        if (requestedTabId.length > 0 && findTabIndexById(requestedTabId) < 0) {
            emitTabResult(payload, false, null, browserError("invalid_tab", "Tab not found.", { tabId: requestedTabId }))
            return
        }
        focusTab(requestedTabId)
        emitTabResult(payload, true, { activeTabId: getActiveTabId(), tabs: listTabs() }, null)
    }

    function resolveCommandTabId(payload) {
        var requestedTabId = String(payload.tabId || "")
        if (requestedTabId.length > 0) {
            return requestedTabId
        }
        return getActiveTabId()
    }

    function routeBrowserCommand(payload) {
        var targetTabId = resolveCommandTabId(payload)
        if (!targetTabId) {
            emitBrowserErrorResult(payload, "", "No browser tabs are open.", { tabId: payload.tabId || null })
            return
        }

        var browserItem = tabBrowserItem(targetTabId)
        if (!browserItem || typeof browserItem.handleMessage !== "function") {
            emitBrowserErrorResult(payload, targetTabId, "Target browser tab is unavailable.", { tabId: targetTabId })
            return
        }

        var forwarded = {}
        for (var key in payload) {
            forwarded[key] = payload[key]
        }
        forwarded.tabId = targetTabId
        browserItem.handleMessage(forwarded)
    }

    function forwardProtocolEvent(tabId, payload) {
        updateTabFromPayload(tabId, payload)
        var forwarded = {}
        for (var key in payload) {
            forwarded[key] = payload[key]
        }
        forwarded.tabId = tabId
        emitProtocol(forwarded)
    }

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object" || !payload.action) return
        if (payload.action === "tab:open") {
            ensureOpenTab(payload)
            return
        }
        if (payload.action === "tab:close") {
            closeTab(payload)
            return
        }
        if (payload.action === "tab:list") {
            emitTabResult(payload, true, { activeTabId: getActiveTabId(), tabs: listTabs() }, null)
            return
        }
        if (payload.action === "tab:switch") {
            switchTab(payload)
            return
        }
        if (String(payload.action).indexOf("browser:") === 0) {
            routeBrowserCommand(payload)
        }
    }

    Rectangle {
        anchors.fill: parent
        color: SpellUI.SpellTheme.background
        visible: tabsModel.count === 0

        Text {
            anchors.centerIn: parent
            text: "Open a browser tab to watch live navigation."
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.textTertiary
        }
    }

    Repeater {
        id: browserRepeater
        model: tabsModel

        delegate: Item {
            required property string tabId
            required property string title
            required property string url
            required property string state

            anchors.fill: parent
            visible: root.getActiveTabId() === tabId

            readonly property alias browserItem: browser

            CanvasComponents.SpellBrowser {
                id: browser
                anchors.fill: parent
                browserProfile: root.sharedProfile
                initialUrl: url || "about:blank"
                autoLoadInitialUrl: true
                onProtocolEvent: function(payload) {
                    root.forwardProtocolEvent(tabId, payload)
                }
            }
        }
    }
}
