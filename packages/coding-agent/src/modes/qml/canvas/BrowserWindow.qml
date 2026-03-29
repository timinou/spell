import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import QtCore
import QtWebEngine
import ".." as SpellUI
import "./components" as Components

ApplicationWindow {
    id: root

    visible: true
    width: windowWidth || 1280
    height: windowHeight || 900
    title: windowTitle || (browser.pageTitle.length > 0 ? browser.pageTitle + " — Spell Browser" : "Spell Browser")
    color: SpellUI.SpellTheme.background

    property var spellArmedTools: ["read", "write", "grep", "find"]
    property string profileStorageName: resolvedProfileStorageName()
    property string settingsCategory: browserSettingsCategory()
    property string settingsFile: resolvedSettingsFile()
    property string initialBrowserUrl: resolvedInitialUrl()
    readonly property var persistentProfile: persistentProfilePrototype.instance()

    function bridgePropsValue(name, fallback) {
        if (typeof bridge === "undefined" || !bridge || !bridge.props) {
            return fallback
        }
        return bridge.props[name] !== undefined && bridge.props[name] !== null ? bridge.props[name] : fallback
    }

    function sanitizeKey(value) {
        return String(value == null ? "" : value)
            .trim()
            .replace(/[^a-zA-Z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48)
    }

    function browserSettingsCategory() {
        var explicitCategory = String(bridgePropsValue("settingsCategory", "")).trim()
        if (explicitCategory.length > 0) {
            return explicitCategory
        }
        return "SpellBrowser-" + profileStorageName
    }

    function resolvedProfileStorageName() {
        var explicit = String(bridgePropsValue("storageName", "spell-browser")).trim()
        var sanitized = sanitizeKey(explicit.length > 0 ? explicit : "spell-browser")
        return sanitized.length > 0 ? sanitized : "spell-browser"
    }

    function resolvedSettingsFile() {
        var explicit = String(bridgePropsValue("settingsFile", "")).trim()
        if (explicit.length > 0) {
            return explicit
        }
        var configRoot = String(StandardPaths.writableLocation(StandardPaths.AppConfigLocation) || "").trim()
        if (configRoot.length === 0) {
            configRoot = String(StandardPaths.writableLocation(StandardPaths.HomeLocation) || "").trim()
        }
        if (configRoot.length === 0) {
            configRoot = "/tmp"
        }
        return configRoot + "/" + profileStorageName + ".ini"
    }

    function resolvedInitialUrl() {
        var explicit = String(bridgePropsValue("initialUrl", "")).trim()
        if (explicit.length > 0) {
            return explicit
        }
        if (settings.lastUrl.length > 0) {
            return settings.lastUrl
        }
        return "about:blank"
    }

    function persistCurrentUrl(urlText) {
        if (!urlText || urlText === "about:blank") {
            return
        }
        settings.lastUrl = urlText
    }

    Settings {
        id: settings
        location: root.settingsFile.indexOf("/") === 0 ? "file://" + root.settingsFile : Qt.resolvedUrl(root.settingsFile)
        category: root.settingsCategory
        property string lastUrl: ""
    }

    WebEngineProfilePrototype {
        id: persistentProfilePrototype
        storageName: root.profileStorageName.length > 0 ? root.profileStorageName : "spell-browser"
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingS

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: toolbarRow.implicitHeight + SpellUI.SpellTheme.spacingM * 2
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderDefault

            RowLayout {
                id: toolbarRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                Button {
                    text: "Back"
                    enabled: browser.canGoBack
                    onClicked: browser.goBack()
                }

                Button {
                    text: "Forward"
                    enabled: browser.canGoForward
                    onClicked: browser.goForward()
                }

                Button {
                    text: browser.loading ? "Stop" : "Reload"
                    onClicked: {
                        if (browser.loading) {
                            browser.stopLoading()
                        } else {
                            browser.reloadPage()
                        }
                    }
                }

                TextField {
                    id: addressField
                    Layout.fillWidth: true
                    placeholderText: "Enter a URL"
                    text: root.initialBrowserUrl
                    selectByMouse: true
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    onAccepted: browser.navigate(text)
                }

                Button {
                    text: "Go"
                    onClicked: browser.navigate(addressField.text)
                }

                Button {
                    text: "Save Session"
                    onClicked: saveSessionDialog.openWithDomain(saveSessionDialog.currentDomain)
                }

                ComboBox {
                    id: profilePicker
                    model: ListModel { id: profileModel }
                    textRole: "name"
                    Layout.preferredWidth: 160
                    currentIndex: 0
                    onActivated: function(index) {
                        var item = profileModel.get(index)
                        if (item && typeof bridge !== "undefined" && bridge) {
                            bridge.send({
                                type: "profile_switch",
                                profileStorage: item.profileStorage
                            })
                        }
                    }
                    Component.onCompleted: {
                        profileModel.append({ name: "Default", profileStorage: "spell-browser" })
                    }
                }
            }
        }

        Components.SpellBrowser {
            id: browser
            Layout.fillWidth: true
            Layout.fillHeight: true
            browserProfile: persistentProfile
            initialUrl: root.initialBrowserUrl
            autoLoadInitialUrl: true
            onProtocolEvent: function(payload) {
                if (typeof bridge !== "undefined" && bridge) {
                    bridge.send(payload)
                }
            }
            onCurrentUrlStringChanged: {
                if (!addressField.activeFocus) {
                    addressField.text = currentUrlString
                }
                root.persistCurrentUrl(currentUrlString)
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: statusRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 1
            border.color: SpellUI.SpellTheme.borderDefault

            RowLayout {
                id: statusRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle {
                    Layout.preferredWidth: 10
                    Layout.preferredHeight: 10
                    radius: 5
                    color: {
                        if (browser.browserState === "loading") return SpellUI.SpellTheme.warning
                        if (browser.browserState === "interactive") return SpellUI.SpellTheme.success
                        if (browser.browserState === "error") return SpellUI.SpellTheme.error
                        return SpellUI.SpellTheme.textTertiary
                    }
                }

                Text {
                    text: browser.browserState
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                }

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: statusText.implicitHeight
                    color: "transparent"

                    Text {
                        id: statusText
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width
                        text: browser.lastError.length > 0 ? browser.lastError : browser.statusText
                        color: browser.lastError.length > 0 ? SpellUI.SpellTheme.error : SpellUI.SpellTheme.textSecondary
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        elide: Text.ElideRight
                    }
                }

                BusyIndicator {
                    running: browser.loading
                    visible: running
                    implicitWidth: 18
                    implicitHeight: 18
                }
            }
        }
    }

    Components.SaveSessionDialog {
        id: saveSessionDialog
        currentDomain: {
            try {
                var url = browser.currentUrlString
                if (url && url.length > 0) {
                    var match = url.match(/^https?:\/\/([^\/:]+)/)
                    return match ? match[1] : ""
                }
            } catch(e) {}
            return ""
        }
        onSessionSaved: function(sessionData) {
            if (typeof bridge !== "undefined" && bridge) {
                bridge.send({
                    type: "save_session",
                    name: sessionData.name,
                    description: sessionData.description,
                    domains: [currentDomain],
                    parentService: sessionData.parentService || undefined
                })
            }
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload && payload.action === "service:profiles") {
                profileModel.clear()
                if (payload.profiles && payload.profiles.length > 0) {
                    for (var i = 0; i < payload.profiles.length; i++) {
                        profileModel.append(payload.profiles[i])
                    }
                } else {
                    profileModel.append({ name: "Default", profileStorage: "spell-browser" })
                }
                return
            }
            browser.handleMessage(payload)
        }
    }

    onClosing: function(close) {
        if (typeof bridge !== "undefined" && bridge) {
            bridge.send({ action: "close" })
        }
    }
}
