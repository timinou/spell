import QtQuick 2.15
import QtQuick.Controls 2.15
import ".." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 800
    height: windowHeight || 600
    title: windowTitle || "Test"
    color: SpellUI.SpellTheme.background

    property var spellArmedTools: ["write", "read", "generate_image"]

    ChatPanel {
        id: chatPanel
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === "query") {
                handleQuery(payload)
            } else if (payload.type === "reset") {
                handleReset()
            } else {
                chatPanel.handleMessage(payload)
            }
        }
    }

    function handleQuery(payload) {
        var queryName = payload.query
        var result = null

        if (queryName === "messages") {
            var msgs = []
            for (var i = 0; i < chatPanel.messagesModel.count; i++) {
                msgs.push(chatPanel.messagesModel.get(i))
            }
            result = msgs
        } else if (queryName === "messageCount") {
            result = chatPanel.messagesModel.count
        } else if (queryName === "isStreaming") {
            result = chatPanel.isStreaming
        } else if (queryName === "lastMessage") {
            var count = chatPanel.messagesModel.count
            result = count > 0 ? chatPanel.messagesModel.get(count - 1) : null
        }

        bridge.send({
            type: "query_response",
            query: queryName,
            result: result
        })
    }

    function handleReset() {
        chatPanel.messagesModel.clear()
        chatPanel.isStreaming = false
        chatPanel.tokenCount = 0
        chatPanel.modelName = ""
        bridge.send({ type: "reset_done" })
    }
}
