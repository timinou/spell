import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    id: root
    visible: true
    width: 1024
    height: 768
    title: "Dashboard Test"

    GrowthDashboard {
        id: dashboard
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === 'reset') {
                dashboard.metrics = { newAds: 0, pendingDeliverables: 0, activeCampaigns: 0 }
                dashboard.recentAds = []
                dashboard.pipeline = { brief: 0, draft: 0, review: 0, final: 0, sent: 0 }
                bridge.send({ type: 'reset_done' })
            }
            // dashboard_data and other messages are handled by GrowthDashboard's own
            // Connections block, which also targets bridge — no forwarding needed.
        }
    }
}
