import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: root

    property string clientId: ""
    property string clientName: ""
    property int campaignCount: 0
    property int deliverableCount: 0
    property string lastActivity: ""

    implicitWidth: 200
    implicitHeight: 110
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
                bridge.send({ type: 'client_selected', clientId: root.clientId })
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 14
        spacing: 6

        Text {
            Layout.fillWidth: true
            text: root.clientName || "Unnamed Client"
            font.pixelSize: 14
            font.weight: Font.SemiBold
            color: "#CDD6F4"
            elide: Text.ElideRight
        }

        // Stats row
        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            ColumnLayout {
                spacing: 2
                Text {
                    text: root.campaignCount.toString()
                    font.pixelSize: 18
                    font.weight: Font.Bold
                    color: "#89B4FA"
                }
                Text {
                    text: "campaigns"
                    font.pixelSize: 10
                    color: "#6C7086"
                }
            }

            ColumnLayout {
                spacing: 2
                Text {
                    text: root.deliverableCount.toString()
                    font.pixelSize: 18
                    font.weight: Font.Bold
                    color: "#CBA6F7"
                }
                Text {
                    text: "deliverables"
                    font.pixelSize: 10
                    color: "#6C7086"
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: root.lastActivity ? "Last: " + root.lastActivity.substring(0, 10) : "No activity"
            font.pixelSize: 11
            color: "#6C7086"
            elide: Text.ElideRight
        }
    }
}
