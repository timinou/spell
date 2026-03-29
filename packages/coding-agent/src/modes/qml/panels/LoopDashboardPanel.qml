import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "../components" as Components

Item {
    id: root

    signal controlRequested(string action, string gateId)

    property string loopId: ""
    property string loopName: ""
    property string loopState: "idle"
    property int iteration: 0
    property int maxIterations: 0
    property double elapsedMs: 0
    property double budgetLimitMs: 0
    property bool autoApproveEnabled: false
    property double autoApproveAt: 0
    property double nowMs: 0
    property string pendingGateId: ""
    property var dagNodes: []
    property var gateResults: []
    property bool confirmingKill: false

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object") return
        if (payload.type !== "loop_snapshot") return
        if (payload.loop) {
            root.loopId = payload.loop.id || ""
            root.loopName = payload.loop.name || ""
            root.loopState = payload.loop.state || "idle"
            root.iteration = Number(payload.loop.iteration || 0)
            root.maxIterations = Number(payload.loop.maxIterations || 0)
            root.elapsedMs = Number(payload.loop.elapsedMs || 0)
            root.budgetLimitMs = Number(payload.loop.budgetLimitMs || 0)
        }
        root.dagNodes = Array.isArray(payload.tree) ? payload.tree : []
        root.gateResults = Array.isArray(payload.gates) ? payload.gates : []
        root.pendingGateId = payload.pendingGateId || ""
        root.autoApproveEnabled = payload.autoApproveEnabled === true
        root.autoApproveAt = Number(payload.autoApproveAt || 0)
        root.nowMs = Number(payload.nowMs || 0)
    }

    Rectangle {
        anchors.fill: parent
        color: SpellUI.SpellTheme.background
    }

    ScrollView {
        anchors.fill: parent
        clip: true

        ColumnLayout {
            width: parent.width
            spacing: SpellUI.SpellTheme.spacingL
            anchors.margins: SpellUI.SpellTheme.spacingL

            Text {
                text: root.loopName.length > 0 ? root.loopName : "Loop Dashboard"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
                font.bold: true
                color: SpellUI.SpellTheme.textPrimary
            }

            Text {
                text: root.loopState + " · iteration " + root.iteration + " / " + root.maxIterations
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                color: SpellUI.SpellTheme.textSecondary
            }

            Text {
                text: "Budget: " + Math.round(root.elapsedMs) + "ms / " + Math.round(root.budgetLimitMs) + "ms"
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                color: SpellUI.SpellTheme.textSecondary
            }

            Components.AutoApproveTimer {
                enabled: root.autoApproveEnabled
                autoApproveAt: root.autoApproveAt
                nowMs: root.nowMs
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Button {
                    objectName: "pauseButton"
                    text: root.loopState === "paused" ? "Resume" : "Pause"
                    onClicked: root.controlRequested(root.loopState === "paused" ? "resume" : "pause", "")
                }

                Button {
                    objectName: "approveButton"
                    text: "Approve"
                    enabled: root.pendingGateId.length > 0
                    onClicked: root.controlRequested("approve", root.pendingGateId)
                }

                Button {
                    objectName: "rejectButton"
                    text: "Reject"
                    enabled: root.pendingGateId.length > 0
                    onClicked: root.controlRequested("reject", root.pendingGateId)
                }

                Button {
                    objectName: "autoApproveButton"
                    text: root.autoApproveEnabled ? "Auto-Approve On" : "Auto-Approve Off"
                    onClicked: root.controlRequested("toggle-auto-approve", root.pendingGateId)
                }

                Button {
                    objectName: "killButton"
                    text: root.confirmingKill ? "Confirm Kill" : "Kill"
                    onClicked: {
                        if (!root.confirmingKill) {
                            root.confirmingKill = true
                            return
                        }
                        root.confirmingKill = false
                        root.controlRequested("kill", "")
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                color: SpellUI.SpellTheme.surface
                radius: SpellUI.SpellTheme.cornerRadius
                border.width: 1
                border.color: SpellUI.SpellTheme.outline
                implicitHeight: dag.implicitHeight + SpellUI.SpellTheme.spacingL * 2

                Components.LoopDAG {
                    id: dag
                    anchors.fill: parent
                    anchors.margins: SpellUI.SpellTheme.spacingL
                    nodes: root.dagNodes
                }
            }

            Rectangle {
                Layout.fillWidth: true
                color: SpellUI.SpellTheme.surface
                radius: SpellUI.SpellTheme.cornerRadius
                border.width: 1
                border.color: SpellUI.SpellTheme.outline
                implicitHeight: timeline.implicitHeight + SpellUI.SpellTheme.spacingL * 2

                Components.GateTimeline {
                    id: timeline
                    anchors.fill: parent
                    anchors.margins: SpellUI.SpellTheme.spacingL
                    gates: root.gateResults
                }
            }
        }
    }
}
