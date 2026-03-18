import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

ApplicationWindow {
    visible: true
    title: "Spell"
    width: windowWidth
    height: windowHeight
    color: "#0b1020"

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#111a33" }
            GradientStop { position: 1.0; color: "#080c18" }
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width * 0.82, 720)
        spacing: 14

        Label {
            text: "SPELL"
            font.pixelSize: 44
            font.bold: true
            color: "#9cc3ff"
            horizontalAlignment: Text.AlignHCenter
            Layout.alignment: Qt.AlignHCenter
        }

        Label {
            text: "I can step beyond chat when you want focus, structure, or interaction."
            wrapMode: Text.Wrap
            color: "#d5e2ff"
            font.pixelSize: 18
            horizontalAlignment: Text.AlignHCenter
            Layout.fillWidth: true
        }

        Frame {
            Layout.fillWidth: true
            background: Rectangle {
                radius: 10
                color: "#121b34"
                border.color: "#2a3d73"
            }

            ColumnLayout {
                anchors.fill: parent
                spacing: 10

                Label {
                    text: "Presence"
                    font.pixelSize: 20
                    color: "#b9d1ff"
                }

                Label {
                    text: "- Exact when stakes are high\n- Interactive when decisions branch\n- Relentless about verification"
                    color: "#d5e2ff"
                    wrapMode: Text.Wrap
                    font.pixelSize: 15
                }
            }
        }

        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: 12

            Button {
                text: "Acknowledge"
                onClicked: bridge.send({ action: "ack", message: "Canvas link established." })
            }

            Button {
                text: "Close"
                onClicked: Qt.quit()
            }
        }
    }
}
