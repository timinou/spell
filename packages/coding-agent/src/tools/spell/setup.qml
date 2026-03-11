import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 2.15

// Spell onboarding window — DankMaterialShell dark palette.
ApplicationWindow {
    id: root

    // ── geometry ───────────────────────────────────────────────────────────────
    width: 460
    minimumWidth: 460
    maximumWidth: 460
    height: body.implicitHeight + root.spXL * 2
    visible: true
    title: "Spell"
    color: clrBg

    // ── DMS dark palette ───────────────────────────────────────────────────────
    readonly property color clrBg:      "#131313"
    readonly property color clrSurface: "#1f1f1f"
    readonly property color clrBorder:  "#474747"
    readonly property color clrText:    "#e2e2e2"
    readonly property color clrMuted:   "#9e9e9e"
    readonly property color clrDimmed:  "#555555"
    readonly property color clrPrimary: "#ffb4a3"
    readonly property color clrError:   "#ffb4ab"
    readonly property color clrSuccess: "#81c995"
    readonly property int   rad:        12
    readonly property int   spS:        8
    readonly property int   spM:        12
    readonly property int   spL:        16
    readonly property int   spXL:       24

    // ── state ──────────────────────────────────────────────────────────────────
    // uiState: "progress" | "success" | "error"
    property string uiState:    "progress"
    property int    currentStep: 0
    property string deviceName: ""
    property string errorText:  ""

    // Step definitions: label shown in list, hint shown beneath the active step.
    readonly property var steps: [
        {
            label: "Connect phone via USB",
            hint:  "Plug in your Android phone using a USB data cable"
        },
        {
            label: "Allow USB debugging",
            hint:  "A dialog has appeared on your phone screen — tap Allow to continue"
        },
        {
            label: "Install Spell",
            hint:  "Installing the Spell remote-display app on your device..."
        },
        {
            label: "Launch Spell",
            hint:  "Starting Spell on your device..."
        },
        {
            label: "Connecting",
            hint:  "Waiting for Spell to establish a connection..."
        }
    ]

    // ── bridge messages ────────────────────────────────────────────────────────
    Connections {
        target: bridge
        function onMessageReceived(msg) {
            const t = msg["type"] ?? ""
            if (t === "step") {
                root.currentStep = msg["index"] ?? 0
            } else if (t === "device") {
                root.deviceName = msg["name"] ?? ""
            } else if (t === "success") {
                root.uiState = "success"
            } else if (t === "error") {
                root.uiState  = "error"
                root.errorText = msg["text"] ?? "Setup failed"
            } else if (t === "close") {
                root.close()
            }
            // "phase" messages are intentionally ignored — the step list
            // carries all visible text; phase text is used by the TUI path.
        }
    }

    // ── root surface ───────────────────────────────────────────────────────────
    Rectangle {
        anchors.fill: parent
        color: root.clrSurface
        radius: root.rad

        // border
        Rectangle {
            anchors.fill: parent
            color: "transparent"
            radius: root.rad
            border.color: root.clrBorder
            border.width: 1
        }

        ColumnLayout {
            id: body
            anchors {
                left:    parent.left
                right:   parent.right
                top:     parent.top
                margins: root.spXL
            }
            spacing: root.spL

            // ── header ─────────────────────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true
                spacing: root.spM

                Rectangle {
                    width: 40; height: 40
                    radius: 10
                    color: Qt.rgba(root.clrPrimary.r, root.clrPrimary.g,
                                   root.clrPrimary.b, 0.15)
                    Text {
                        anchors.centerIn: parent
                        text: "⬡"
                        font.pixelSize: 22
                        color: root.clrPrimary
                    }
                }

                ColumnLayout {
                    spacing: 2
                    Text {
                        text: "Spell"
                        font.pixelSize: 15
                        font.weight: Font.Medium
                        color: root.clrText
                    }
                    Text {
                        text: root.deviceName !== "" ? root.deviceName
                                                     : "Android remote display"
                        font.pixelSize: 12
                        color: root.clrMuted
                    }
                }
            }

            // divider
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: root.clrBorder
                opacity: 0.5
            }

            // ── step list ──────────────────────────────────────────────────────
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0

                Repeater {
                    model: root.steps

                    delegate: ColumnLayout {
                        required property var   modelData
                        required property int   index
                        Layout.fillWidth: true
                        spacing: 0

                        // Per-step derived states. On success every step is done.
                        readonly property bool isDone:   root.uiState === "success"
                                                       || (root.uiState === "progress" && index < root.currentStep)
                        readonly property bool isActive: root.uiState === "progress" && index === root.currentStep
                        readonly property bool isFuture: root.uiState === "progress" && index > root.currentStep

                        // label row
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: root.spM
                            Layout.topMargin:    root.spS
                            Layout.bottomMargin: isActive && modelData.hint !== "" ? 2 : root.spS

                            // 20×20 indicator: spinner | checkmark | dot
                            Item {
                                width: 20; height: 20

                                // arc spinner — NumberAnimation drives a plain
                                // numeric property; RotationAnimator only works
                                // with the built-in `rotation` property.
                                Canvas {
                                    id: stepSpinner
                                    anchors.fill: parent
                                    visible: isActive
                                    opacity: visible ? 1.0 : 0.0
                                    property real angle: 0

                                    NumberAnimation on angle {
                                        from: 0; to: 360
                                        duration: 900
                                        loops: Animation.Infinite
                                        running: isActive
                                    }
                                    Timer {
                                        running: isActive
                                        interval: 16
                                        repeat: true
                                        onTriggered: stepSpinner.requestPaint()
                                    }
                                    onPaint: {
                                        const ctx = getContext("2d")
                                        ctx.clearRect(0, 0, width, height)
                                        const cx = width / 2, cy = height / 2, r = 7
                                        const s = angle * Math.PI / 180
                                        ctx.beginPath()
                                        ctx.arc(cx, cy, r, s, s + Math.PI * 1.35)
                                        ctx.strokeStyle = root.clrPrimary
                                        ctx.lineWidth   = 2
                                        ctx.lineCap     = "round"
                                        ctx.stroke()
                                    }
                                    Behavior on opacity { NumberAnimation { duration: 150 } }
                                }

                                // checkmark (done)
                                Text {
                                    anchors.centerIn: parent
                                    visible: isDone
                                    opacity: visible ? 1.0 : 0.0
                                    text: "✓"
                                    font.pixelSize: 14
                                    color: root.clrSuccess
                                    Behavior on opacity { NumberAnimation { duration: 150 } }
                                }

                                // dot (future)
                                Rectangle {
                                    anchors.centerIn: parent
                                    visible: isFuture
                                    opacity: visible ? 1.0 : 0.0
                                    width: 5; height: 5
                                    radius: 3
                                    color: root.clrDimmed
                                    Behavior on opacity { NumberAnimation { duration: 150 } }
                                }
                            }

                            Text {
                                Layout.fillWidth: true
                                text: modelData.label
                                font.pixelSize: 13
                                font.weight: isActive ? Font.Medium : Font.Normal
                                color: isActive  ? root.clrText
                                     : isDone    ? root.clrMuted
                                     :             root.clrDimmed
                                Behavior on color { ColorAnimation { duration: 150 } }
                            }
                        }

                        // hint beneath the active step (hidden when inactive)
                        Text {
                            Layout.fillWidth: true
                            Layout.leftMargin:   20 + root.spM
                            Layout.bottomMargin: root.spS
                            visible:  isActive && modelData.hint !== ""
                            opacity:  visible ? 1.0 : 0.0
                            text:     modelData.hint
                            font.pixelSize: 11
                            color:    root.clrMuted
                            wrapMode: Text.WordWrap
                            Behavior on opacity { NumberAnimation { duration: 150 } }
                        }
                    }
                }
            }

            // error message (shown when uiState === "error")
            Text {
                Layout.fillWidth: true
                visible:  root.uiState === "error"
                opacity:  visible ? 1.0 : 0.0
                text:     root.errorText
                font.pixelSize: 13
                color:    root.clrError
                wrapMode: Text.WordWrap
                Behavior on opacity { NumberAnimation { duration: 200 } }
            }

            // ── cancel button ──────────────────────────────────────────────────
            Item {
                Layout.fillWidth: true
                height: 44
                visible: root.uiState !== "success"

                Rectangle {
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    width:  Math.max(80, cancelLabel.contentWidth + root.spXL)
                    height: 34
                    radius: root.rad
                    color:  cancelArea.containsMouse
                            ? Qt.rgba(root.clrText.r, root.clrText.g, root.clrText.b, 0.07)
                            : "transparent"
                    border.color: root.clrBorder
                    border.width: 1

                    Text {
                        id: cancelLabel
                        anchors.centerIn: parent
                        text: "Cancel"
                        font.pixelSize: 13
                        color: root.clrText
                    }

                    MouseArea {
                        id: cancelArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: () => {
                            bridge.send({ action: "cancel" })
                            root.close()
                        }
                    }

                    Behavior on color { ColorAnimation { duration: 120 } }
                }
            }
        }
    }

    Shortcut {
        sequence: "Escape"
        onActivated: () => {
            bridge.send({ action: "cancel" })
            root.close()
        }
    }
}
