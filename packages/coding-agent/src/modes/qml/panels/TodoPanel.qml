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
        if (status === "in_progress") return SpellUI.SpellTheme.accent
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
                        color: SpellUI.SpellTheme.accent
                        Layout.topMargin: index > 0 ? SpellUI.SpellTheme.spacingS : 0
                    }

                    // Tasks in phase
                    Repeater {
                        model: modelData.tasks || []

                        delegate: Rectangle {
                            required property var modelData
                            Layout.fillWidth: true
                            color: SpellUI.SpellTheme.surfaceHigh
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            border.width: 1
                            border.color: SpellUI.SpellTheme.outline
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
                                }

                                // Gate toggle row (only if any gate is set)
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: SpellUI.SpellTheme.spacingS
                                    visible: (modelData.verifyCommit === true) ||
                                             (typeof modelData.verifyArtifact === "string" && modelData.verifyArtifact.length > 0) ||
                                             (typeof modelData.verifyCmd === "string" && modelData.verifyCmd.length > 0) ||
                                             (typeof modelData.verifyReview === "string" && modelData.verifyReview.length > 0)

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
