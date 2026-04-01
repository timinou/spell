import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

Item {
    id: dashboardPanel

    property var metrics: ({ newAds: 0, pendingDeliverables: 0, activeCampaigns: 0 })
    property var recentAds: []
    property var pipeline: ({ brief: 0, draft: 0, review: 0, final: 0, sent: 0 })

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16

        // Metric summary strip
        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            MetricCard {
                title: "New Competitor Ads"
                value: dashboardPanel.metrics.newAds
            }
            MetricCard {
                title: "Pending Deliverables"
                value: dashboardPanel.metrics.pendingDeliverables
            }
            MetricCard {
                title: "Active Campaigns"
                value: dashboardPanel.metrics.activeCampaigns
            }

            Item { Layout.fillWidth: true }
        }

        // Pipeline stage strip
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Repeater {
                model: [
                    { label: "Brief",  count: dashboardPanel.pipeline.brief  },
                    { label: "Draft",  count: dashboardPanel.pipeline.draft  },
                    { label: "Review", count: dashboardPanel.pipeline.review },
                    { label: "Final",  count: dashboardPanel.pipeline.final  },
                    { label: "Sent",   count: dashboardPanel.pipeline.sent   }
                ]

                delegate: Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 40
                    radius: 6
                    color: "#1E1E2E"
                    border.color: "#313244"
                    border.width: 1

                    ColumnLayout {
                        anchors.centerIn: parent
                        spacing: 2

                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: modelData.count !== undefined ? modelData.count.toString() : "0"
                            font.pixelSize: 16
                            font.weight: Font.Bold
                            color: "#CDD6F4"
                        }
                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: modelData.label
                            font.pixelSize: 10
                            color: "#6C7086"
                        }
                    }
                }
            }
        }

        // Competitor ad feed header
        Text {
            text: "Recent Competitor Ads"
            font.pixelSize: 13
            font.weight: Font.SemiBold
            color: "#A6ADC8"
        }

        // Feed — fills remaining vertical space
        ListView {
            id: feedView
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 6
            clip: true
            model: dashboardPanel.recentAds

            delegate: AdSummaryCard {
                width: feedView.width
                adId: modelData.adId || ""
                pageName: modelData.pageName || ""
                adText: modelData.creativeBody || ""
                startDate: modelData.deliveryStartTime || ""
                isActive: modelData.isActive || false
            }

            // Empty state
            Text {
                anchors.centerIn: parent
                visible: feedView.count === 0
                text: "No competitor ads yet"
                font.pixelSize: 13
                color: "#6C7086"
            }
        }

        // Quick actions
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Button {
                text: "New Report"
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'quick_action', action: 'new_report' })
                    }
                }
            }
            Button {
                text: "Scan Competitors"
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'quick_action', action: 'scan' })
                    }
                }
            }
            Button {
                text: "Review Performance"
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'quick_action', action: 'review' })
                    }
                }
            }

            Item { Layout.fillWidth: true }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'dashboard_data') {
                dashboardPanel.metrics   = payload.metrics   || dashboardPanel.metrics
                dashboardPanel.recentAds = payload.recentAds || []
                dashboardPanel.pipeline  = payload.pipeline  || dashboardPanel.pipeline
            }
        }
    }

    Component.onCompleted: {
        if (typeof bridge !== 'undefined') {
            bridge.send({ type: 'panel_ready', panelId: 'dashboard' })
        }
    }
}
