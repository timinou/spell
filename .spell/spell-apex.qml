pragma ComponentBehavior: Bound
import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import QtQuick.Shapes 1.15

ApplicationWindow {
    id: root
    visible: true
    title: "Spell Apex"
    width: windowWidth
    height: windowHeight
    color: "#05070f"

    property real phase: 0
    property real tone: 0.77
    property string mode: "Architect"
    property real amplitude: 0.82
    property real frequency: 1.25
    property real complexity: 0.46
    property real coupling: 0.58
    property real driftX: 0
    property real driftY: 0

    Timer {
        interval: 16
        running: true
        repeat: true
        onTriggered: root.phase += 0.016
    }

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.00; color: Qt.hsla((0.61 + 0.08 * Math.sin(root.phase * 0.19)) % 1, 0.58, 0.08, 1) }
            GradientStop { position: 0.50; color: Qt.hsla((0.69 + 0.11 * Math.sin(root.phase * 0.22 + 2.2)) % 1, 0.54, 0.06, 1) }
            GradientStop { position: 1.00; color: Qt.hsla((0.82 + 0.07 * Math.cos(root.phase * 0.16)) % 1, 0.50, 0.05, 1) }
        }
    }

    Item {
        anchors.fill: parent
        Repeater {
            model: 120
            delegate: Rectangle {
                required property int index
                width: 2 + (index % 4)
                height: width
                radius: width / 2
                color: Qt.hsla((0.56 + index * 0.01 + root.phase * 0.01) % 1, 0.95, 0.78, 0.45)
                x: ((index * 43) % root.width) + (50 + 55 * root.complexity) * Math.sin(root.phase * (0.35 + root.frequency * 0.15) + index * (0.17 + root.coupling * 0.2)) + root.driftX * 0.35
                y: ((index * 97) % root.height) + (50 + 55 * root.complexity) * Math.cos(root.phase * (0.31 + root.frequency * 0.11) + index * (0.14 + root.coupling * 0.2)) + root.driftY * 0.35
                opacity: 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(root.phase + index))
            }
        }
    }

    RowLayout {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 14

        Frame {
            Layout.fillHeight: true
            Layout.preferredWidth: Math.max(420, root.width * 0.40)
            background: Rectangle {
                radius: 14
                color: "#0f1734d8"
                border.color: "#7ca2ff88"
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 16
                spacing: 10

                Label {
                    text: "SPELL APEX"
                    font.pixelSize: 34
                    font.bold: true
                    color: "#d8e7ff"
                }

                Label {
                    text: "Embodiment state machine: strategy + precision + interaction"
                    color: "#b8ceff"
                    wrapMode: Text.Wrap
                    Layout.fillWidth: true
                }

                Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: "#86a6f055" }

                GridLayout {
                    columns: 2
                    columnSpacing: 10
                    rowSpacing: 8
                    Layout.fillWidth: true

                    Label { text: "Mode"; color: "#dce9ff" }
                    ComboBox {
                        id: modeBox
                        model: ["Architect", "Operator", "Auditor", "Strategist"]
                        currentIndex: 0
                        Layout.fillWidth: true
                        onCurrentTextChanged: root.mode = currentText
                    }

                    Label { text: "Tone"; color: "#dce9ff" }
                    Slider {
                        id: toneSlider
                        from: 0
                        to: 1
                        value: root.tone
                        stepSize: 0.01
                        Layout.fillWidth: true
                        onMoved: root.tone = value
                    }

                    Label { text: "Amplitude"; color: "#dce9ff" }
                    Slider {
                        from: 0.2
                        to: 1.8
                        value: root.amplitude
                        stepSize: 0.01
                        Layout.fillWidth: true
                        onMoved: root.amplitude = value
                    }

                    Label { text: "Frequency"; color: "#dce9ff" }
                    Slider {
                        from: 0.3
                        to: 2.4
                        value: root.frequency
                        stepSize: 0.01
                        Layout.fillWidth: true
                        onMoved: root.frequency = value
                    }

                    Label { text: "Complexity"; color: "#dce9ff" }
                    Slider {
                        from: 0
                        to: 1
                        value: root.complexity
                        stepSize: 0.01
                        Layout.fillWidth: true
                        onMoved: root.complexity = value
                    }

                    Label { text: "Coupling"; color: "#dce9ff" }
                    Slider {
                        from: 0
                        to: 1
                        value: root.coupling
                        stepSize: 0.01
                        Layout.fillWidth: true
                        onMoved: root.coupling = value
                    }

                    Label { text: "Contract"; color: "#dce9ff" }
                    CheckBox { id: strictMode; text: "Strict"; checked: true }

                    Label { text: "Response"; color: "#dce9ff" }
                    CheckBox { id: conciseMode; text: "Concise"; checked: true }
                }

                Label {
                    text: "Directive"
                    color: "#dce9ff"
                    font.bold: true
                }

                TextArea {
                    id: directiveInput
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    placeholderText: "Enter high-level intent..."
                    wrapMode: TextArea.Wrap
                    color: "#eaf1ff"
                    background: Rectangle {
                        radius: 10
                        color: "#0a1128"
                        border.color: "#4f70c6"
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Button {
                        text: "Transmit"
                        onClicked: bridge.send({
                            action: "directive",
                            mode: root.mode,
                            tone: root.tone,
                            strict: strictMode.checked,
                            concise: conciseMode.checked,
                            text: directiveInput.text
                        })
                    }
                    Button {
                        text: "State Ping"
                        onClicked: bridge.send({
                            action: "state",
                            mode: root.mode,
                            tone: root.tone,
                            amplitude: root.amplitude,
                            frequency: root.frequency,
                            complexity: root.complexity,
                            coupling: root.coupling,
                            driftX: root.driftX,
                            driftY: root.driftY,
                            phase: root.phase
                        })
                    }
                    Item { Layout.fillWidth: true }
                    Button {
                        text: "Close"
                        onClicked: Qt.quit()
                    }
                }
            }
        }

        Frame {
            Layout.fillWidth: true
            Layout.fillHeight: true
            background: Rectangle {
                radius: 14
                color: "#0d1430cc"
                border.color: "#7ca2ff88"
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 16
                spacing: 10

                Label {
                    text: "Signal Core"
                    font.pixelSize: 24
                    color: "#d8e7ff"
                    font.bold: true
                }

                Shape {
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.max(260, root.height * 0.38)
                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        onPositionChanged: function(mouse) {
                            root.driftX = mouse.x - width / 2
                            root.driftY = mouse.y - height / 2
                        }
                        onExited: {
                            root.driftX = 0
                            root.driftY = 0
                        }
                    }

                    ShapePath {
                        strokeColor: "#8fb2ff"
                        strokeWidth: 2
                        fillColor: "transparent"
                        startX: 0
                        startY: 120 + root.driftY * 0.03
                        PathCubic {
                            x: 900
                            y: 120 + root.driftY * 0.03
                            control1X: 220 + root.driftX * 0.08
                            control1Y: 120 + (85 * root.amplitude) * Math.sin(root.phase * ((1.5 + root.tone) * root.frequency) + root.complexity * 1.2)
                            control2X: 620 - root.driftX * 0.08
                            control2Y: 120 + (85 * root.amplitude) * Math.cos(root.phase * ((1.2 + root.tone) * root.frequency) + root.coupling * 1.1)
                        }
                    }

                    ShapePath {
                        strokeColor: "#6cf1ff"
                        strokeWidth: 1
                        fillColor: "transparent"
                        startX: 0
                        startY: 170 + root.driftY * 0.04
                        PathCubic {
                            x: 900
                            y: 170 + root.driftY * 0.04
                            control1X: 260 + root.driftX * 0.06
                            control1Y: 170 + (75 * root.amplitude) * Math.sin(root.phase * ((1.8 + root.tone * 0.7) * root.frequency) + 1.2 + root.complexity * 2.2)
                            control2X: 590 - root.driftX * 0.06
                            control2Y: 170 + (75 * root.amplitude) * Math.cos(root.phase * ((1.3 + root.tone * 0.8) * root.frequency) + 0.9 + root.coupling * 2.0)
                        }
                    }

                    ShapePath {
                        strokeColor: "#ffd66c"
                        strokeWidth: 1
                        fillColor: "transparent"
                        startX: 0
                        startY: 220 + root.driftY * 0.05
                        PathCubic {
                            x: 900
                            y: 220 + root.driftY * 0.05
                            control1X: 180 + root.driftX * 0.10
                            control1Y: 220 + (62 * root.amplitude) * Math.sin(root.phase * ((2.1 + root.tone * 0.9) * root.frequency) + root.coupling * 3.1)
                            control2X: 710 - root.driftX * 0.10
                            control2Y: 220 + (62 * root.amplitude) * Math.cos(root.phase * ((1.7 + root.tone * 0.5) * root.frequency) + root.complexity * 3.3)
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 170
                    radius: 12
                    color: "#0a1128"
                    border.color: "#4565b0"

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 12
                        spacing: 6

                        Label { text: "mode      : " + root.mode; color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "tone      : " + root.tone.toFixed(3); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "amplitude : " + root.amplitude.toFixed(3); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "frequency : " + root.frequency.toFixed(3); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "complexity: " + root.complexity.toFixed(3); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "coupling  : " + root.coupling.toFixed(3); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "drift     : (" + root.driftX.toFixed(1) + ", " + root.driftY.toFixed(1) + ")"; color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "phase     : " + root.phase.toFixed(2); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "constraint: " + (strictMode.checked ? "strict" : "flexible"); color: "#dce9ff"; font.family: "monospace" }
                        Label { text: "style     : " + (conciseMode.checked ? "concise" : "expanded"); color: "#dce9ff"; font.family: "monospace" }
                    }
                }

                Item { Layout.fillHeight: true }

                Label {
                    text: "Directive received: Take your embodiment to the next level"
                    color: "#9dc1ff"
                    font.italic: true
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                }
            }
        }
    }
}