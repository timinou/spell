import QtQuick 2.15
import QtQuick.Controls 2.15
import ".." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 700
    title: windowTitle || "Browse Chat Test"
    color: SpellUI.SpellTheme.background

    BrowseChatPanel {
        id: chatPanel
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === "reset") {
                handleReset()
                return
            }
            chatPanel.handleMessage(payload)
        }
    }

    function handleReset() {
        chatPanel.messagesModel.clear()
        chatPanel.isStreaming = false
        chatPanel.tokenCount = 0
        chatPanel.modelName = ""
        chatPanel.autoFollow = true
        bridge.send({ type: "reset_done" })
    }
}
