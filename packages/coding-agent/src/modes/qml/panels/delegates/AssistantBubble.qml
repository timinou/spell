import QtQuick 2.15
import "../.." as SpellUI
import "../markdown" as Markdown

Rectangle {
    id: root
    required property string text
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int messageIndex
    property bool isError: false

    width: parent ? parent.width : 0
    height: markdownContent.height + SpellUI.SpellTheme.spacingL * 2
    color: SpellUI.SpellTheme.surfaceHigh
    radius: SpellUI.SpellTheme.cornerRadius

    Markdown.MarkdownContent {
        id: markdownContent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: SpellUI.SpellTheme.spacingL
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
