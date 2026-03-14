import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import "../markdown" as Markdown

Rectangle {
    id: root
    required property string text
    required property string thinking
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false

    width: parent ? parent.width : 0
    height: contentCol.height + SpellUI.SpellTheme.spacingL * 2
    color: SpellUI.SpellTheme.surfaceHigh
    radius: SpellUI.SpellTheme.cornerRadius

    ColumnLayout {
        id: contentCol
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: SpellUI.SpellTheme.spacingL
        spacing: SpellUI.SpellTheme.spacingS

        // Thinking block — muted italic prose rendered above the response
        ColumnLayout {
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS
            visible: root.thinking.length > 0

            Text {
                Layout.fillWidth: true
                text: root.thinking
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                font.italic: true
                color: SpellUI.SpellTheme.textSecondary
                wrapMode: Text.Wrap
            }

            // Divider between thinking and response text — only when response has started
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: SpellUI.SpellTheme.outline
                visible: root.text.length > 0
            }
        }

        Markdown.MarkdownContent {
            id: markdownContent
            Layout.fillWidth: true
            visible: root.text.length > 0
            text: root.text
            isStreaming: root.isStreaming
            onCodeSaveRequested: function(content, lang) {
                bridge.send({
                    _tool: "write",
                    path: "/tmp/spell-code-" + Date.now() + "." + (lang || "txt"),
                    content: content
                })
            }
            onLinkActivated: function(link) {
                if (link.indexOf("file://") === 0) {
                    bridge.send({
                        _tool: "read",
                        _rid: "preview-" + Date.now(),
                        path: link.substring(7)
                    })
                } else {
                    Qt.openUrlExternally(link)
                }
            }
        }
    }
}
