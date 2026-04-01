import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

Item {
    id: intelPanel

    property var ads: []
    property var selectedAd: null

    // Drawer open state — set by clicking a card
    property bool drawerOpen: selectedAd !== null

    RowLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16

        // Main column: filter + grid
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 12

            FilterToolbar {
                id: toolbar
                Layout.fillWidth: true
            }

            // Ad grid
            GridView {
                id: adGrid
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true

                cellWidth:  260
                cellHeight: 160

                model: intelPanel.ads

                delegate: AdCard {
                    width:  adGrid.cellWidth  - 10
                    height: adGrid.cellHeight - 10

                    adId:      modelData.adId              || ""
                    pageName:  modelData.pageName          || ""
                    adText:    modelData.creativeBody       || ""
                    startDate: modelData.deliveryStartTime || ""
                    isActive:  modelData.isActive          || false
                    adFormat:  modelData.adFormat          || ""
                }

                // Empty state
                Text {
                    anchors.centerIn: parent
                    visible: adGrid.count === 0
                    text: "No ads match the current filter"
                    font.pixelSize: 13
                    color: "#6C7086"
                }
            }
        }

        // Detail drawer — slides in from the right when a card is selected
        Rectangle {
            id: detailDrawer
            Layout.preferredWidth: intelPanel.drawerOpen ? 320 : 0
            Layout.fillHeight: true
            visible: width > 0
            clip: true
            color: "#181825"
            border.color: "#313244"
            border.width: 1
            radius: 8

            Behavior on Layout.preferredWidth {
                NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 16
                spacing: 12
                visible: intelPanel.selectedAd !== null

                // Close button
                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        Layout.fillWidth: true
                        text: "Ad Detail"
                        font.pixelSize: 14
                        font.weight: Font.SemiBold
                        color: "#CDD6F4"
                    }

                    Button {
                        text: "✕"
                        implicitWidth: 28
                        implicitHeight: 28
                        flat: true
                        onClicked: intelPanel.selectedAd = null
                    }
                }

                // Page name
                Text {
                    Layout.fillWidth: true
                    text: intelPanel.selectedAd ? (intelPanel.selectedAd.pageName || "") : ""
                    font.pixelSize: 16
                    font.weight: Font.Bold
                    color: "#CDD6F4"
                    elide: Text.ElideRight
                }

                // Status
                Rectangle {
                    implicitWidth: statusText.implicitWidth + 12
                    implicitHeight: 22
                    radius: 4
                    color: intelPanel.selectedAd && intelPanel.selectedAd.isActive ? "#1e3a2f" : "#2a2a3a"

                    Text {
                        id: statusText
                        anchors.centerIn: parent
                        text: intelPanel.selectedAd
                              ? (intelPanel.selectedAd.isActive ? "Active" : "Ended")
                              : ""
                        font.pixelSize: 12
                        color: intelPanel.selectedAd && intelPanel.selectedAd.isActive
                               ? "#A6E3A1" : "#6C7086"
                    }
                }

                // Full ad text
                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    Text {
                        width: detailDrawer.width - 32
                        text: intelPanel.selectedAd ? (intelPanel.selectedAd.creativeBody || "No text") : ""
                        font.pixelSize: 13
                        color: "#BAC2DE"
                        wrapMode: Text.WordWrap
                    }
                }

                // Dates
                GridLayout {
                    columns: 2
                    columnSpacing: 8
                    rowSpacing: 4

                    Text { text: "Start:"; font.pixelSize: 11; color: "#6C7086" }
                    Text {
                        text: intelPanel.selectedAd
                              ? (intelPanel.selectedAd.deliveryStartTime || "—").substring(0, 10)
                              : "—"
                        font.pixelSize: 11
                        color: "#CDD6F4"
                    }

                    Text { text: "Format:"; font.pixelSize: 11; color: "#6C7086" }
                    Text {
                        text: intelPanel.selectedAd ? (intelPanel.selectedAd.adFormat || "—") : "—"
                        font.pixelSize: 11
                        color: "#89DCEB"
                    }
                }
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'ads_data') {
                intelPanel.ads = payload.ads || []
            }
            if (payload.type === 'open_ad_detail') {
                // Find the ad in the local model and open drawer
                const found = intelPanel.ads.find(a => a.adId === payload.adId)
                if (found) intelPanel.selectedAd = found
            }
        }
    }

    Component.onCompleted: {
        if (typeof bridge !== 'undefined') {
            bridge.send({ type: 'panel_ready', panelId: 'intel' })
        }
    }
}
