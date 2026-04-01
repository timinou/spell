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

    implicitHeight: 52
    radius: 6
    color: hoverArea.containsMouse ? "#25253A" : "transparent"
    border.color: "#313244"
    border.width: 1

    Behavior on color { ColorAnimation { duration: 80 } }

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

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        spacing: 10

        // Status dot
        Rectangle {
            width: 8
            height: 8
            radius: 4
            color: root.isActive ? "#A6E3A1" : "#6C7086"
        }

        // Page name
        Text {
            Layout.preferredWidth: 120
            text: root.pageName || "Unknown"
            font.pixelSize: 13
            font.weight: Font.Medium
            color: "#CDD6F4"
            elide: Text.ElideRight
        }

        // Ad text
        Text {
            Layout.fillWidth: true
            text: root.adText || "No creative text"
            font.pixelSize: 12
            color: "#A6ADC8"
            elide: Text.ElideRight
        }

        // Date
        Text {
            text: root.startDate ? root.startDate.substring(0, 10) : "—"
            font.pixelSize: 11
            color: "#6C7086"
        }
    }
}
