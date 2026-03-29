import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "." as SpellUI
import "panels" as Panels

ApplicationWindow {
    visible: true
    width: windowWidth || 960
    height: windowHeight || 720
    title: windowTitle || "Loop Dashboard"
    color: SpellUI.SpellTheme.background

    Panels.LoopDashboardPanel {
        id: dashboard
        anchors.fill: parent
        onControlRequested: function(action, gateId) {
            bridge.send({ type: "loop_control", action: action, gateId: gateId, loopId: dashboard.loopId })
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            dashboard.handleMessage(payload)
        }
    }
}
