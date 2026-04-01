import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: root

    property string title: ""
    property var value: 0
    property var delta: null
    property string icon: ""

    implicitWidth: 160
    implicitHeight: 88
    radius: 8
    color: "#1E1E2E"
    border.color: "#313244"
    border.width: 1

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 14
        spacing: 4

        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.icon
                font.pixelSize: 14
                color: "#CDD6F4"
                visible: root.icon !== ""
            }

            Text {
                Layout.fillWidth: true
                text: root.title
                font.pixelSize: 11
                color: "#A6ADC8"
                elide: Text.ElideRight
            }
        }

        Text {
            Layout.fillWidth: true
            text: root.value !== null && root.value !== undefined ? root.value.toString() : "—"
            font.pixelSize: 28
            font.weight: Font.Bold
            color: "#CDD6F4"
        }

        // Delta badge — shown only when delta is provided and non-null
        Rectangle {
            visible: root.delta !== null && root.delta !== undefined
            implicitWidth: deltaLabel.implicitWidth + 10
            implicitHeight: 18
            radius: 4
            color: {
                if (root.delta === null || root.delta === undefined) return "transparent"
                return root.delta >= 0 ? "#1e3a2f" : "#3a1e1e"
            }

            Text {
                id: deltaLabel
                anchors.centerIn: parent
                text: {
                    if (root.delta === null || root.delta === undefined) return ""
                    const sign = root.delta >= 0 ? "+" : ""
                    return sign + root.delta.toString()
                }
                font.pixelSize: 11
                color: root.delta !== null && root.delta !== undefined && root.delta >= 0 ? "#A6E3A1" : "#F38BA8"
            }
        }
    }
}
