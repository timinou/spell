import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    id: root
    visible: true
    width: 1024
    height: 768
    title: "Intel Panel Test"

    IntelPanel {
        id: intelPanel
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === 'reset') {
                // Clear ads and selected ad so each test starts clean
                intelPanel.ads = []
                intelPanel.selectedAd = null
                bridge.send({ type: 'reset_done' })
            } else if (payload.type === 'ads_query_result') {
                // Armed-tool response format → feed directly into panel model
                intelPanel.ads = payload.ads || []
            }
        }
    }
}
