import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Drawer {
    id: detailDrawer
    width: 400
    height: parent.height
    edge: Qt.RightEdge

    property var adDetail: null

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12
        visible: adDetail !== null

        // Header
        RowLayout {
            Layout.fillWidth: true
            Label {
                text: adDetail?.pageName || ""
                font.pixelSize: 18
                font.bold: true
                color: "#F9FAFB"
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
            Button {
                text: "✕"
                flat: true
                implicitWidth: 32
                implicitHeight: 32
                contentItem: Text {
                    text: parent.text
                    font.pixelSize: 14
                    color: "#9CA3AF"
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
                background: Rectangle {
                    radius: 4
                    color: parent.hovered ? "#313244" : "transparent"
                }
                onClicked: detailDrawer.close()
            }
        }

        // Status badge
        Label {
            text: adDetail?.isActive ? "Active" : "Inactive"
            color: adDetail?.isActive ? "#059669" : "#DC2626"
            font.pixelSize: 12
            font.weight: Font.Medium
        }

        // Creative body text
        ScrollView {
            Layout.fillWidth: true
            Layout.preferredHeight: 200
            clip: true

            TextArea {
                text: adDetail?.creativeBody || ""
                readOnly: true
                wrapMode: TextEdit.Wrap
                color: "#D1D5DB"
                background: Rectangle {
                    color: "#1E1E2E"
                    radius: 4
                    border.color: "#45475A"
                    border.width: 1
                }
                font.pixelSize: 12
                padding: 8
            }
        }

        // Metrics
        Label { text: "Spend: "       + (adDetail?.spendRange       || "N/A"); color: "#9CA3AF"; font.pixelSize: 12 }
        Label { text: "Impressions: " + (adDetail?.impressionsRange  || "N/A"); color: "#9CA3AF"; font.pixelSize: 12 }
        Label { text: "Started: "     + (adDetail?.deliveryStartTime || "N/A"); color: "#9CA3AF"; font.pixelSize: 12 }

        // Actions
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Button {
                text: adDetail?.starred ? "Unstar" : "Star"
                Layout.fillWidth: true
                onClicked: {
                    if (adDetail && typeof bridge !== 'undefined') {
                        bridge.send({
                            type: 'annotate_ad',
                            adId: adDetail.adId,
                            starred: !adDetail.starred
                        })
                    }
                }
            }

            Button {
                text: "Analyze"
                Layout.fillWidth: true
                onClicked: {
                    if (adDetail && typeof bridge !== 'undefined') {
                        bridge.send({
                            type: 'analyze_ad',
                            adId: adDetail.adId
                        })
                    }
                }
            }
        }

        Item { Layout.fillHeight: true }
    }
}
