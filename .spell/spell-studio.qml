pragma ComponentBehavior: Bound
import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import QtQuick.Shapes 1.15

ApplicationWindow {
    id: root
    visible: true
    title: "Spell Studio"
    width: windowWidth
    height: windowHeight
    color: "#04060d"

    property real t: 0
    Timer {
        interval: 16
        running: true
        repeat: true
        onTriggered: root.t += 0.016
    }

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: Qt.hsla((0.58 + 0.08 * Math.sin(root.t * 0.3)) % 1, 0.55, 0.10, 1) }
            GradientStop { position: 0.5; color: Qt.hsla((0.70 + 0.10 * Math.sin(root.t * 0.21 + 1.7)) % 1, 0.45, 0.08, 1) }
            GradientStop { position: 1.0; color: Qt.hsla((0.82 + 0.07 * Math.cos(root.t * 0.27)) % 1, 0.50, 0.06, 1) }
        }
    }

    Repeater {
        model: 18
        delegate: Rectangle {
            required property int index
            width: 220 + (index % 5) * 30
            height: width
            radius: width / 2
            color: "transparent"
            border.width: 1
            border.color: Qt.hsla((0.55 + index * 0.03 + root.t * 0.02) % 1, 0.9, 0.7, 0.18)
            x: (root.width * (index % 6) / 6) + 40 * Math.sin(root.t * 0.6 + index)
            y: (root.height * Math.floor(index / 6) / 3) + 35 * Math.cos(root.t * 0.8 + index * 0.7)
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 24
        spacing: 14

        Frame {
            Layout.fillWidth: true
            background: Rectangle {
                radius: 12
                color: "#0e1430cc"
                border.color: "#5f89ff99"
            }
            RowLayout {
                anchors.fill: parent
                spacing: 16

                Label {
                    text: "SPELL // UNBOUNDED QML"
                    color: "#dbe6ff"
                    font.pixelSize: 26
                    font.bold: true
                    Layout.fillWidth: true
                }

                Button {
                    text: "Pulse"
                    onClicked: bridge.send({ action: "pulse", phase: root.t })
                }
                Button {
                    text: "Snapshot Intent"
                    onClicked: bridge.send({ action: "intent", mode: modeSelector.currentText, tone: toneSlider.value })
                }
                Button {
                    text: "Exit"
                    onClicked: Qt.quit()
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 16

            Frame {
                Layout.fillWidth: true
                Layout.fillHeight: true
                background: Rectangle { radius: 10; color: "#111a38c8"; border.color: "#6f92ff70" }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 14
                    spacing: 10

                    Label {
                        text: "Embodiment Controls"
                        color: "#bdd2ff"
                        font.pixelSize: 18
                        font.bold: true
                    }

                    ComboBox {
                        id: modeSelector
                        Layout.fillWidth: true
                        model: ["Analyst", "Architect", "Adversarial Reviewer", "Calm Operator"]
                    }

                    Label { text: "Tone"; color: "#d7e4ff" }
                    Slider {
                        id: toneSlider
                        from: 0
                        to: 1
                        value: 0.42
                        Layout.fillWidth: true
                    }

                    CheckBox { id: strictCheck; text: "Strict mode"; checked: true }
                    CheckBox { id: conciseCheck; text: "Concise responses"; checked: true }

                    Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: "#7a95db55" }

                    TextArea {
                        id: directive
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        wrapMode: TextArea.Wrap
                        color: "#e4edff"
                        selectedTextColor: "#07122b"
                        selectionColor: "#bcd2ff"
                        placeholderText: "Type a direct instruction for Spell..."
                        background: Rectangle {
                            radius: 8
                            color: "#0a1024"
                            border.color: "#4a66b3"
                        }
                    }

                    Button {
                        text: "Transmit Directive"
                        Layout.alignment: Qt.AlignRight
                        onClicked: bridge.send({
                            action: "directive",
                            mode: modeSelector.currentText,
                            tone: toneSlider.value,
                            strict: strictCheck.checked,
                            concise: conciseCheck.checked,
                            text: directive.text
                        })
                    }
                }
            }

            Frame {
                Layout.preferredWidth: Math.max(320, root.width * 0.34)
                Layout.fillHeight: true
                background: Rectangle { radius: 10; color: "#0e1530cc"; border.color: "#6f92ff70" }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 14
                    spacing: 8

                    Label {
                        text: "Live Signal"
                        color: "#bdd2ff"
                        font.pixelSize: 18
                        font.bold: true
                    }

                    Shape {
                        Layout.fillWidth: true
                        Layout.preferredHeight: 190
                        ShapePath {
                            strokeColor: "#89adff"
                            strokeWidth: 2
                            fillColor: "transparent"
                            startX: 0
                            startY: 120
                            PathCubic {
                                x: 300
                                y: 120
                                control1X: 80
                                control1Y: 120 + 50 * Math.sin(root.t * 2.1)
                                control2X: 220
                                control2Y: 120 + 50 * Math.cos(root.t * 1.7)
                            }
                        }
                    }

                    Label {
                        text: "phase: " + root.t.toFixed(2)
                        color: "#d9e5ff"
                        font.family: "monospace"
                    }
                    Label {
                        text: "mode: " + modeSelector.currentText
                        color: "#d9e5ff"
                        font.family: "monospace"
                    }
                    Label {
                        text: "strict: " + (strictCheck.checked ? "on" : "off") + "  concise: " + (conciseCheck.checked ? "on" : "off")
                        color: "#d9e5ff"
                        font.family: "monospace"
                    }

                    Item { Layout.fillHeight: true }

                    Label {
                        text: "You said: break away. Done."
                        color: "#9cc3ff"
                        font.italic: true
                    }
                }
            }
        }
    }
}