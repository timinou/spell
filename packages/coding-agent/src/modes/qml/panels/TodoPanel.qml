import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: todoPanel

    signal controlRequested(string taskId, string gate, bool enabled)

    property var todoPhases: []

    function handleMessage(payload: var): void {
        if (!payload || typeof payload !== "object") return
        if (payload.type !== "todo_snapshot") return
        todoPanel.todoPhases = Array.isArray(payload.phases) ? payload.phases : []
    }

    function statusIcon(status: string, blocked: bool): string {
        if (blocked) return "\u26D4"
        if (status === "completed") return "\u2713"
        if (status === "in_progress") return "\u2192"
        if (status === "abandoned") return "\u2717"
        return "\u25CB"
    }

    function statusColor(status: string, blocked: bool): color {
        if (blocked) return SpellUI.SpellTheme.warning
        if (status === "completed") return SpellUI.SpellTheme.success
        if (status === "in_progress") return SpellUI.SpellTheme.primary
        if (status === "abandoned") return SpellUI.SpellTheme.error
        return SpellUI.SpellTheme.textTertiary
    }

    Rectangle {
        anchors.fill: parent
        color: "transparent"
    }

    ScrollView {
        anchors.fill: parent
        clip: true

        ColumnLayout {
            width: parent.width
            spacing: SpellUI.SpellTheme.spacingM

            Text {
                text: "Tasks"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                font.bold: true
                color: SpellUI.SpellTheme.textPrimary
            }

            Repeater {
                model: todoPanel.todoPhases

                delegate: ColumnLayout {
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    spacing: SpellUI.SpellTheme.spacingXS

                    // Phase header
                    Text {
                        text: modelData.name || ("Phase " + (index + 1))
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                        font.bold: true
                        color: SpellUI.SpellTheme.primary
                        Layout.topMargin: index > 0 ? SpellUI.SpellTheme.spacingS : 0
                    }

                    // Tasks in phase
                    Repeater {
                        model: modelData.tasks || []

                        delegate: Rectangle {
                            required property var modelData
                            // A node carrying a reviewer-swarm gate or kind="loop" is a
                            // sub-loop: accent its border so the loop reads as one unit (FEAT-816).
                            readonly property bool isLoop: (modelData.kind === "loop") ||
                                     (modelData.verifySwarm && modelData.verifySwarm.count > 0)
                            Layout.fillWidth: true
                            color: SpellUI.SpellTheme.surfaceHigh
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            border.width: isLoop ? 2 : 1
                            border.color: isLoop ? SpellUI.SpellTheme.primary : SpellUI.SpellTheme.outline
                            implicitHeight: taskColumn.implicitHeight + SpellUI.SpellTheme.spacingS * 2

                            ColumnLayout {
                                id: taskColumn
                                anchors.fill: parent
                                anchors.margins: SpellUI.SpellTheme.spacingS
                                spacing: SpellUI.SpellTheme.spacingXS

                                // Task header row: icon + content
                                RowLayout {
                                    spacing: SpellUI.SpellTheme.spacingS

                                    Text {
                                        text: todoPanel.statusIcon(modelData.status || "pending", modelData.blocked === true)
                                        font.family: SpellUI.SpellTheme.monoFontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                        color: todoPanel.statusColor(modelData.status || "pending", modelData.blocked === true)
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: modelData.content || ""
                                        font.family: SpellUI.SpellTheme.fontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                        color: SpellUI.SpellTheme.textPrimary
                                        elide: Text.ElideRight
                                        wrapMode: Text.NoWrap
                                    }

                                    // Model/agent badge: which subagent drives this task/swarm (A3).
                                    Rectangle {
                                        objectName: "modelBadge_" + (modelData.id || "")
                                        visible: typeof modelData.delegationAgent === "string" && modelData.delegationAgent.length > 0
                                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                                        color: SpellUI.SpellTheme.surface
                                        border.width: 1
                                        border.color: SpellUI.SpellTheme.primary
                                        implicitWidth: badgeText.implicitWidth + SpellUI.SpellTheme.spacingS * 2
                                        implicitHeight: badgeText.implicitHeight + SpellUI.SpellTheme.spacingXS
                                        Text {
                                            id: badgeText
                                            anchors.centerIn: parent
                                            text: (modelData.delegationAgent || "")
                                            font.family: SpellUI.SpellTheme.monoFontFamily
                                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                            color: SpellUI.SpellTheme.primary
                                        }
                                    }
                                }

                                // Gate toggle row (only if any gate is set)
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: SpellUI.SpellTheme.spacingS
                                    visible: (modelData.verifyCommit === true) ||
                                             (typeof modelData.verifyArtifact === "string" && modelData.verifyArtifact.length > 0) ||
                                             (typeof modelData.verifyCmd === "string" && modelData.verifyCmd.length > 0) ||
                                             (typeof modelData.verifyReview === "string" && modelData.verifyReview.length > 0) ||
                                             (modelData.verifySwarm && modelData.verifySwarm.count > 0)

                                    CheckBox {
                                        objectName: "verifyCommit_" + (modelData.id || "")
                                        text: "commit"
                                        checked: modelData.verifyCommit === true
                                        font.family: SpellUI.SpellTheme.monoFontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                        onToggled: todoPanel.controlRequested(modelData.id || "", "commit", checked)
                                    }

                                    CheckBox {
                                        objectName: "verifyArtifact_" + (modelData.id || "")
                                        text: "artifact"
                                        checked: typeof modelData.verifyArtifact === "string" && modelData.verifyArtifact.length > 0
                                        font.family: SpellUI.SpellTheme.monoFontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                        onToggled: todoPanel.controlRequested(modelData.id || "", "artifact", checked)
                                    }

                                    CheckBox {
                                        objectName: "verifyCmd_" + (modelData.id || "")
                                        text: "cmd"
                                        checked: typeof modelData.verifyCmd === "string" && modelData.verifyCmd.length > 0
                                        font.family: SpellUI.SpellTheme.monoFontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                        onToggled: todoPanel.controlRequested(modelData.id || "", "cmd", checked)
                                    }

                                    CheckBox {
                                        objectName: "verifyReview_" + (modelData.id || "")
                                        text: "review"
                                        checked: typeof modelData.verifyReview === "string" && modelData.verifyReview.length > 0
                                        font.family: SpellUI.SpellTheme.monoFontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                        onToggled: todoPanel.controlRequested(modelData.id || "", "review", checked)
                                    }

                                    // Reviewer-swarm gate — read-only chip (count is set in KDL/todo,
                                    // not a simple toggle). Names what must pass before the loop closes.
                                    Rectangle {
                                        objectName: "verifySwarm_" + (modelData.id || "")
                                        visible: modelData.verifySwarm && modelData.verifySwarm.count > 0
                                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                                        color: SpellUI.SpellTheme.surface
                                        border.width: 1
                                        border.color: SpellUI.SpellTheme.primary
                                        implicitWidth: swarmChip.implicitWidth + SpellUI.SpellTheme.spacingS * 2
                                        implicitHeight: swarmChip.implicitHeight + SpellUI.SpellTheme.spacingXS
                                        Text {
                                            id: swarmChip
                                            anchors.centerIn: parent
                                            text: "swarm ×" + (modelData.verifySwarm ? modelData.verifySwarm.count : 0)
                                            font.family: SpellUI.SpellTheme.monoFontFamily
                                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                            color: SpellUI.SpellTheme.primary
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Empty state
            Text {
                visible: todoPanel.todoPhases.length === 0
                text: "No active tasks"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                color: SpellUI.SpellTheme.textTertiary
            }
        }
    }
}
