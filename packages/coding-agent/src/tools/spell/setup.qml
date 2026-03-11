import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 2.15

// Spell onboarding window — styled to match DankMaterialShell visual language.
// Colors sourced from the current matugen dark palette.
ApplicationWindow {
    id: root

    // ── geometry ──────────────────────────────────────────────────────────────
    width: 460
    minimumWidth: 460
    maximumWidth: 460
    // height is driven by the content column; give it a sensible default
    height: body.implicitHeight + root.spXL * 2
    visible: true
    title: "Spell"
    color: clrBg

    // ── DMS dark palette ──────────────────────────────────────────────────────
    readonly property color clrBg:          "#131313"
    readonly property color clrSurface:     "#1f1f1f"
    readonly property color clrSurfaceHigh: "#2a2a2a"
    readonly property color clrBorder:      "#474747"
    readonly property color clrText:        "#e2e2e2"
    readonly property color clrMuted:       "#9e9e9e"
    readonly property color clrPrimary:     "#ffb4a3"
    readonly property color clrError:       "#ffb4ab"
    readonly property color clrSuccess:     "#81c995"
    readonly property int   rad:            12
    readonly property int   spS:            8
    readonly property int   spM:            12
    readonly property int   spL:            16
    readonly property int   spXL:           24

    // ── state ─────────────────────────────────────────────────────────────────
    // phase: "progress" | "success" | "error"
    property string phase:       "progress"
    property string phaseText:   "Starting..."
    property string deviceName:  ""

    // ── bridge messages ───────────────────────────────────────────────────────
    Connections {
        target: bridge
        function onMessageReceived(msg) {
            const t = msg["type"] ?? ""
            if (t === "phase") {
                root.phase     = "progress"
                root.phaseText = msg["text"] ?? ""
            } else if (t === "device") {
                root.deviceName = msg["name"] ?? ""
            } else if (t === "success") {
                root.phase     = "success"
                root.phaseText = "Connected"
            } else if (t === "error") {
                root.phase     = "error"
                root.phaseText = msg["text"] ?? "Setup failed"
            } else if (t === "close") {
                root.close()
            }
        }
    }

    // ── root surface ──────────────────────────────────────────────────────────
    Rectangle {
        anchors.fill: parent
        color: root.clrSurface
        radius: root.rad

        // outer glow / border
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
                left:   parent.left
                right:  parent.right
                top:    parent.top
                margins: root.spXL
            }
            spacing: root.spL

            // ── header ────────────────────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true
                spacing: root.spM

                // icon chip
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
                        font.family: "Inter Variable, Inter, sans-serif"
                        font.pixelSize: 15
                        font.weight: Font.Medium
                        color: root.clrText
                    }
                    Text {
                        text: root.deviceName !== "" ? root.deviceName
                                                     : "Android remote display"
                        font.family: "Inter Variable, Inter, sans-serif"
                        font.pixelSize: 12
                        color: root.clrMuted
                        Behavior on text { }
                    }
                }
            }

            // ── divider ───────────────────────────────────────────────────────
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: root.clrBorder
                opacity: 0.5
            }

            // ── phase row ─────────────────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true
                spacing: root.spM

                // spinner / status icon (24×24 cell)
                Item {
                    width: 24; height: 24

                    // animated arc spinner
                    Canvas {
                        id: spinnerCanvas
                        anchors.fill: parent
                        visible: root.phase === "progress"
                        opacity: visible ? 1 : 0

                        property real angle: 0

                        onPaint: {
                            const ctx = getContext("2d")
                            ctx.clearRect(0, 0, width, height)
                            const cx = width / 2, cy = height / 2, r = 9
                            const start = angle * Math.PI / 180
                            const end   = start + Math.PI * 1.35
                            ctx.beginPath()
                            ctx.arc(cx, cy, r, start, end)
                            ctx.strokeStyle = root.clrPrimary
                            ctx.lineWidth   = 2.5
                            ctx.lineCap     = "round"
                            ctx.stroke()
                        }

                        RotationAnimator on angle {
                            from: 0; to: 360
                            duration: 900
                            loops: Animation.Infinite
                            running: root.phase === "progress"
                        }

                        // redraw every frame while spinning
                        Timer {
                            running: root.phase === "progress"
                            interval: 16
                            repeat: true
                            onTriggered: spinnerCanvas.requestPaint()
                        }

                        Behavior on opacity {
                            NumberAnimation { duration: 200 }
                        }
                    }

                    // success checkmark
                    Text {
                        anchors.centerIn: parent
                        visible: root.phase === "success"
                        opacity: visible ? 1 : 0
                        text: "✓"
                        font.pixelSize: 18
                        color: root.clrSuccess
                        Behavior on opacity { NumberAnimation { duration: 200 } }
                    }

                    // error cross
                    Text {
                        anchors.centerIn: parent
                        visible: root.phase === "error"
                        opacity: visible ? 1 : 0
                        text: "✕"
                        font.pixelSize: 16
                        color: root.clrError
                        Behavior on opacity { NumberAnimation { duration: 200 } }
                    }
                }

                Text {
                    Layout.fillWidth: true
                    text: root.phaseText
                    font.family: "Inter Variable, Inter, sans-serif"
                    font.pixelSize: 13
                    color: {
                        if (root.phase === "success") return root.clrSuccess
                        if (root.phase === "error")   return root.clrError
                        return root.clrText
                    }
                    wrapMode: Text.WordWrap

                    Behavior on color { ColorAnimation { duration: 200 } }
                }
            }

            // ── cancel button row ─────────────────────────────────────────────
            Item {
                Layout.fillWidth: true
                height: 44

                Rectangle {
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    width: Math.max(80, cancelLabel.contentWidth + root.spXL)
                    height: 34
                    radius: root.rad
                    color: cancelArea.containsMouse
                           ? Qt.rgba(root.clrText.r, root.clrText.g,
                                     root.clrText.b, 0.07)
                           : "transparent"
                    border.color: root.clrBorder
                    border.width: 1
                    visible: root.phase !== "success"
                    opacity: visible ? 1 : 0

                    Text {
                        id: cancelLabel
                        anchors.centerIn: parent
                        text: "Cancel"
                        font.family: "Inter Variable, Inter, sans-serif"
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

                    Behavior on color   { ColorAnimation  { duration: 120 } }
                    Behavior on opacity { NumberAnimation { duration: 200 } }
                }
            }
        }
    }

    // close window when user presses Escape
    Shortcut {
        sequence: "Escape"
        onActivated: () => {
            bridge.send({ action: "cancel" })
            root.close()
        }
    }
}
