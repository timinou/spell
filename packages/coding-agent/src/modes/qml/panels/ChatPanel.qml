import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "delegates" as Delegates

Item {
    id: chatPanel

    property bool isStreaming: false
    property int tokenCount: 0
    property string modelName: ""

    // Exposed for test introspection — not used by production code.
    readonly property alias messagesModel: messagesModel
    ListModel {
        id: messagesModel
    }

    // --- Message handler dispatch ---

    property var handlers: ({
        message_start: function(msg) {
            messagesModel.append({
                msgId: msg.id || "",
                role: msg.role || "assistant",
                text: "",
                name: "",
                isStreaming: true,
                isExpanded: false,
                isError: false
            })
            chatPanel.isStreaming = true
            messageList.positionViewAtEnd()
        },

        message_update: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    var current = messagesModel.get(i).text
                    messagesModel.setProperty(i, "text", current + (msg.text || ""))
                    break
                }
            }
            messageList.positionViewAtEnd()
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
        },

        tool_start: function(msg) {
            messagesModel.append({
                msgId: msg.id || "",
                role: "tool",
                text: msg.details || "",
                name: msg.name || "tool",
                isStreaming: true,
                isExpanded: false,
                isError: false
            })
            messageList.positionViewAtEnd()
        },

        tool_update: function(msg) {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    if (msg.details) messagesModel.setProperty(i, "text", msg.details)
                    break
                }
            }
            messageList.positionViewAtEnd()
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
        },

        agent_busy: function(msg) {
            chatPanel.isStreaming = !!msg.busy
        },

        model_info: function(msg) {
            chatPanel.modelName = msg.model || ""
        },

        user_message: function(msg) {
            messagesModel.append({
                msgId: "user-" + Date.now(),
                role: "user",
                text: msg.text || "",
                name: "",
                isStreaming: false,
                isExpanded: false,
                isError: false
            })
            messageList.positionViewAtEnd()
        },

        image_result: function(msg) {
            messagesModel.append({
                msgId: msg.id || "img-" + Date.now(),
                role: "image",
                text: msg.data || "",
                name: msg.mimeType || "image/png",
                isStreaming: false,
                isExpanded: false,
                isError: false
            })
            messageList.positionViewAtEnd()
        }
    })

    function handleMessage(msg) {
        if (!msg || !msg.type) return
        var handler = handlers[msg.type]
        if (handler) handler(msg)
    }

    function sendUserMessage(text) {
        messagesModel.append({
            msgId: "user-" + Date.now(),
            role: "user",
            text: text,
            name: "",
            isStreaming: false,
            isExpanded: false,
            isError: false
        })
        messageList.positionViewAtEnd()
        bridge.send({ type: "prompt", text: text })
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Message list
        ListView {
            id: messageList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: SpellUI.SpellTheme.spacingS
            leftMargin: SpellUI.SpellTheme.spacingXL
            rightMargin: SpellUI.SpellTheme.spacingXL
            topMargin: SpellUI.SpellTheme.spacingL
            bottomMargin: SpellUI.SpellTheme.spacingL

            model: messagesModel

            delegate: Delegates.MessageDelegate {
                onToggleExpanded: function(index) {
                    messagesModel.setProperty(index, "isExpanded", !messagesModel.get(index).isExpanded)
                }
            }

            // Streaming indicator
            footer: Item {
                width: messageList.width - messageList.leftMargin - messageList.rightMargin
                height: chatPanel.isStreaming ? 20 : 0
                visible: chatPanel.isStreaming

                Rectangle {
                    id: streamDot
                    width: 8
                    height: 8
                    radius: 4
                    color: SpellUI.SpellTheme.primary
                    anchors.verticalCenter: parent.verticalCenter

                    SequentialAnimation on opacity {
                        running: chatPanel.isStreaming
                        loops: Animation.Infinite
                        NumberAnimation { from: 1.0; to: 0.3; duration: 600 }
                        NumberAnimation { from: 0.3; to: 1.0; duration: 600 }
                    }
                }
            }
        }

        InputBar {
            id: inputBar
            isStreaming: chatPanel.isStreaming
            onMessageSent: function(text) {
                chatPanel.sendUserMessage(text)
            }
            onAbortRequested: bridge.send({ type: "abort" })
        }

        StatusBar {
            modelName: chatPanel.modelName
            tokenCount: chatPanel.tokenCount
        }
    }
}
