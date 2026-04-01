import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    id: root
    visible: true
    width: 1280
    height: 768
    title: "Editor Panel Test"

    EditorPanel {
        id: editorPanel
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === 'reset') bridge.send({ type: 'reset_done' })
        }
    }
}
