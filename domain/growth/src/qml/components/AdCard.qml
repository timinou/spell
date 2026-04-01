import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: root

    property string adId: ""
    property string pageName: ""
    property string adText: ""
    property string startDate: ""
    property bool isActive: false
    property string adFormat: ""

    implicitWidth: 240
    implicitHeight: 140
    radius: 8
    color: hoverArea.containsMouse ? "#25253A" : "#1E1E2E"
    border.color: hoverArea.containsMouse ? "#89B4FA" : "#313244"
    border.width: 1

    Behavior on color { ColorAnimation { duration: 100 } }
    Behavior on border.color { ColorAnimation { duration: 100 } }

    MouseArea {
        id: hoverArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: {
            if (typeof bridge !== 'undefined') {
                bridge.send({ type: 'open_ad_detail', adId: root.adId })
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 6

        // Header: page name + status badge
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Text {
                Layout.fillWidth: true
                text: root.pageName || "Unknown Page"
                font.pixelSize: 13
                font.weight: Font.Medium
                color: "#CDD6F4"
                elide: Text.ElideRight
            }

            Rectangle {
                implicitWidth: statusLabel.implicitWidth + 10
                implicitHeight: 18
                radius: 4
                color: root.isActive ? "#1e3a2f" : "#2a2a3a"

                Text {
                    id: statusLabel
                    anchors.centerIn: parent
                    text: root.isActive ? "Active" : "Ended"
                    font.pixelSize: 10
                    color: root.isActive ? "#A6E3A1" : "#6C7086"
                }
            }
        }

        // Ad text preview
        Text {
            Layout.fillWidth: true
            Layout.fillHeight: true
            text: root.adText || "No creative text"
            font.pixelSize: 12
            color: "#BAC2DE"
            elide: Text.ElideRight
            wrapMode: Text.WordWrap
            maximumLineCount: 3
        }

        // Footer: date + format
        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.startDate ? root.startDate.substring(0, 10) : "—"
                font.pixelSize: 11
                color: "#6C7086"
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.adFormat || ""
                font.pixelSize: 11
                color: "#89DCEB"
                visible: root.adFormat !== ""
            }
        }
    }
}
