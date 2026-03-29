import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "markdown" as Markdown

Item {
    id: root
    objectName: "contentViewerPanel"

    property string contentUrl: ""
    property string contentTitle: ""
    property string contentBody: ""
    property string searchQuery: ""

    signal viewInBrowser(string url, string title)

    function loadContent(url, title, body) {
        root.contentUrl = url || ""
        root.contentTitle = title || ""
        root.contentBody = body || ""
        root.searchQuery = ""
    }

    function handleMessage(payload) {
        if (payload && payload.type === "load_content") {
            loadContent(payload.url, payload.title, payload.content)
        }
    }

    function domainFromUrl(url) {
        var raw = String(url || "")
        var match = raw.match(/^[a-z]+:\/\/([^/]+)/i)
        return match ? match[1].replace(/^www\./, "") : raw
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Top bar
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: topBarRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2
            color: SpellUI.SpellTheme.surface0
            border.width: 0

            RowLayout {
                id: topBarRow
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                // Document icon
                Text {
                    text: "\uD83D\uDCC4"
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                }

                // Title / URL display
                Text {
                    Layout.fillWidth: true
                    text: root.contentTitle.length > 0 ? root.contentTitle : root.domainFromUrl(root.contentUrl)
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    color: SpellUI.SpellTheme.textPrimary
                    elide: Text.ElideRight
                }

                // Search input
                Rectangle {
                    implicitWidth: 200
                    implicitHeight: searchInput.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.surface1
                    border.width: searchInput.activeFocus ? 1 : 0
                    border.color: SpellUI.SpellTheme.primary

                    TextInput {
                        id: searchInput
                        objectName: "contentSearchInput"
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingXS
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textPrimary
                        clip: true
                        onTextChanged: root.searchQuery = text
                    }

                    Text {
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingXS
                        visible: searchInput.text.length === 0 && !searchInput.activeFocus
                        text: "Search..."
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textTertiary
                    }
                }

                // Copy button
                Rectangle {
                    objectName: "copyContentButton"
                    implicitWidth: copyText.implicitWidth + SpellUI.SpellTheme.spacingL
                    implicitHeight: copyText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.surface1

                    Text {
                        id: copyText
                        anchors.centerIn: parent
                        text: "Copy"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textPrimary
                    }

                    SpellUI.StateLayer {
                        onClicked: {
                            if (root.contentBody.length > 0) {
                                var textEdit = Qt.createQmlObject('import QtQuick 2.15; TextEdit { visible: false }', root)
                                textEdit.text = root.contentBody
                                textEdit.selectAll()
                                textEdit.copy()
                                textEdit.destroy()
                            }
                        }
                    }
                }

                // Open in browser button
                Rectangle {
                    objectName: "openInBrowserButton"
                    implicitWidth: browserText.implicitWidth + SpellUI.SpellTheme.spacingL
                    implicitHeight: browserText.implicitHeight + SpellUI.SpellTheme.spacingXS
                    radius: SpellUI.SpellTheme.cornerRadiusSmall
                    color: SpellUI.SpellTheme.surface1
                    visible: root.contentUrl.length > 0

                    Text {
                        id: browserText
                        anchors.centerIn: parent
                        text: "Open in browser"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        color: SpellUI.SpellTheme.textPrimary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.viewInBrowser(root.contentUrl, root.contentTitle)
                    }
                }
            }
        }

        // Separator
        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: SpellUI.SpellTheme.borderSubtle
        }

        // Content area
        Flickable {
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: mdContent.height + SpellUI.SpellTheme.spacingXL * 2
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Markdown.MarkdownContent {
                id: mdContent
                width: parent.width - SpellUI.SpellTheme.spacingXL * 2
                x: SpellUI.SpellTheme.spacingXL
                y: SpellUI.SpellTheme.spacingXL
                text: root.contentBody
                isStreaming: false
            }

            // No content placeholder
            Text {
                anchors.centerIn: parent
                visible: root.contentBody.length === 0
                text: root.contentUrl.length > 0 ? "Content unavailable. Open in browser to view." : "No content loaded"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                color: SpellUI.SpellTheme.textTertiary
            }
        }
    }
}
