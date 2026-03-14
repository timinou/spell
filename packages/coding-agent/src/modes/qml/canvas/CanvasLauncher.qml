import QtQuick 2.15
import QtQuick.Controls 2.15
import ".." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 600
    title: windowTitle || "Canvas"
    color: SpellUI.SpellTheme.background

    AgentCanvas {
        id: canvas
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            canvas.handleMessage(payload)
        }
    }

    onClosing: function(close) {
        bridge.send({ action: "close" })
    }
}
