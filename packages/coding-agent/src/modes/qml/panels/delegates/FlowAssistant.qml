import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import "../markdown" as Markdown

Item {
    id: root
    objectName: "flowAssistant"

    required property string text
    property string thinking: ""
    required property bool isStreaming
    property bool showSeparator: false

    width: parent ? parent.width : 0
    implicitHeight: content.implicitHeight

    ColumnLayout {
        id: content
        width: parent.width
        spacing: SpellUI.SpellTheme.spacingM

        Rectangle {
            Layout.fillWidth: true
            height: 1
            visible: root.showSeparator
            color: SpellUI.SpellTheme.borderSubtle
        }

        ThinkingBlock {
            Layout.fillWidth: true
            visible: root.thinking.length > 0
            text: root.thinking
            showSeparator: false
        }

        Markdown.MarkdownContent {
            id: markdownContent
            Layout.fillWidth: true
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

        Text {
            objectName: "assistantCursor"
            visible: root.isStreaming
            text: "▋"
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.primary
        }
    }
}
