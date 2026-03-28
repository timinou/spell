import QtQuick 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "delegates" as Delegates

Item {
    id: chatPanel
    objectName: "browseChatPanel"

    property bool isStreaming: false
    property int tokenCount: 0
    property string modelName: ""
    property bool autoFollow: true
    property int autoFollowThreshold: 64

    signal viewInTab(string tabId, string url, string title)

    onViewInTab: bridge.send({ type: "view_in_tab", tabId: tabId, url: url, title: title })

    readonly property alias messagesModel: messagesModel

    ListModel {
        id: messagesModel
    }

    function normalizeMessage(message) {
        return {
            msgId: message.msgId || "",
            role: message.role || "assistant",
            text: message.text || "",
            thinking: message.thinking || "",
            name: message.name || "",
            isStreaming: !!message.isStreaming,
            isExpanded: !!message.isExpanded,
            isError: !!message.isError,
            title: message.title || "",
            url: message.url || "",
            excerpt: message.excerpt || "",
            tagsText: Array.isArray(message.tags) ? message.tags.join("\n") : (message.tagsText || ""),
            tabId: message.tabId || ""
        }
    }

    function isNearBottom() {
        return messageList.contentHeight - (messageList.contentY + messageList.height) <= chatPanel.autoFollowThreshold
    }

    function updateAutoFollow() {
        chatPanel.autoFollow = isNearBottom()
    }

    function scrollToEndIfSticky() {
        if (!chatPanel.autoFollow) return
        Qt.callLater(function() {
            messageList.positionViewAtEnd()
        })
    }

    function appendMessage(message) {
        messagesModel.append(normalizeMessage(message))
        scrollToEndIfSticky()
    }

    property var handlers: ({
        message_start: function(msg) {
            appendMessage({
                msgId: msg.id || "",
                role: msg.role || "assistant",
                isStreaming: true
            })
            chatPanel.isStreaming = true
        },

        message_update: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    var currentText = messagesModel.get(i).text
                    messagesModel.setProperty(i, "text", currentText + (msg.text || ""))
                    if (msg.thinking !== undefined) messagesModel.setProperty(i, "thinking", msg.thinking)
                    break
                }
            }
            scrollToEndIfSticky()
        },

        message_end: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    messagesModel.setProperty(i, "isStreaming", false)
                    break
                }
            }
            chatPanel.isStreaming = false
            if (msg.tokens) chatPanel.tokenCount = msg.tokens
            scrollToEndIfSticky()
        },

        tool_start: function(msg) {
            appendMessage({
                msgId: msg.id || "",
                role: "tool",
                text: msg.details || "",
                name: msg.name || "tool",
                isStreaming: true
            })
        },

        tool_update: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    if (msg.details) messagesModel.setProperty(i, "text", msg.details)
                    break
                }
            }
            scrollToEndIfSticky()
        },

        tool_end: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    messagesModel.setProperty(i, "isStreaming", false)
                    messagesModel.setProperty(i, "isError", !!msg.isError)
                    if (msg.details) messagesModel.setProperty(i, "text", msg.details)
                    break
                }
            }
            scrollToEndIfSticky()
        },

        agent_busy: function(msg) {
            chatPanel.isStreaming = !!msg.busy
        },

        model_info: function(msg) {
            chatPanel.modelName = msg.model || ""
        },

        user_message: function(msg) {
            appendMessage({
                msgId: "user-" + Date.now(),
                role: "user",
                text: msg.text || ""
            })
        },

        image_result: function(msg) {
            appendMessage({
                msgId: msg.id || "img-" + Date.now(),
                role: "image",
                text: msg.data || "",
                name: msg.mimeType || "image/png"
            })
        },

        finding: function(msg) {
            appendMessage({
                msgId: msg.id || "finding-" + Date.now(),
                role: "finding",
                title: msg.title || msg.url || "Finding",
                url: msg.url || "",
                excerpt: msg.excerpt || "",
                tags: Array.isArray(msg.tags) ? msg.tags : [],
                tabId: msg.tabId || ""
            })
        }
    })

    function handleMessage(msg) {
        if (!msg || !msg.type) return
        var handler = handlers[msg.type]
        if (handler) handler(msg)
    }

    function sendUserMessage(text) {
        appendMessage({
            msgId: "user-" + Date.now(),
            role: "user",
            text: text
        })
        bridge.send({ type: "prompt", text: text })
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        ListView {
            id: messageList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: SpellUI.SpellTheme.spacingL
            leftMargin: SpellUI.SpellTheme.spacingXL
            rightMargin: SpellUI.SpellTheme.spacingXL
            topMargin: SpellUI.SpellTheme.spacingXL
            bottomMargin: SpellUI.SpellTheme.spacingXL
            model: messagesModel
            boundsBehavior: Flickable.StopAtBounds

            onMovementStarted: chatPanel.updateAutoFollow()
            onMovementEnded: chatPanel.updateAutoFollow()
            onFlickStarted: chatPanel.updateAutoFollow()
            onFlickEnded: chatPanel.updateAutoFollow()
            onContentYChanged: {
                if (moving || flicking) chatPanel.updateAutoFollow()
            }
            onContentHeightChanged: chatPanel.scrollToEndIfSticky()
            onHeightChanged: chatPanel.scrollToEndIfSticky()

            delegate: Delegates.FlowMessageDelegate {
                onToggleExpanded: function(index) {
                    messagesModel.setProperty(index, "isExpanded", !messagesModel.get(index).isExpanded)
                }
                onViewInTab: function(tabId, url, title) {
                    chatPanel.viewInTab(tabId, url, title)
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            color: SpellUI.SpellTheme.background
            implicitHeight: inputBar.implicitHeight + SpellUI.SpellTheme.spacingL * 2

            Delegates.FlowInputBar {
                id: inputBar
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.leftMargin: SpellUI.SpellTheme.spacingXL
                anchors.rightMargin: SpellUI.SpellTheme.spacingXL
                anchors.bottomMargin: SpellUI.SpellTheme.spacingL
                isStreaming: chatPanel.isStreaming
                onMessageSent: function(text) {
                    chatPanel.sendUserMessage(text)
                }
                onAbortRequested: bridge.send({ type: "abort" })
            }
        }
    }
}
