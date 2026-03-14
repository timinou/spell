import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: canvasRoot

    // Content model: JS array of {id, type, data}
    property var blocksModel: []
    // Prompt model: JS array of {promptId, type, question, options, answered, response}
    property var promptsModel: []

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingL
        spacing: SpellUI.SpellTheme.spacingM

        // Scrollable block area
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            ColumnLayout {
                id: blocksColumn
                width: parent.width
                spacing: SpellUI.SpellTheme.spacingM

                Repeater {
                    model: blocksModel

                    delegate: ContentBlock {
                        required property var modelData
                        blockId: modelData.id || ""
                        blockType: modelData.type || "unknown"
                        blockData: modelData.data || {}
                        Layout.fillWidth: true
                        onComponentEvent: function(eventType, eventData) {
                            bridge.send({action: "event", type: eventType, data: eventData})
                        }
                    }
                }
            }
        }

        // Prompt area at bottom
        ColumnLayout {
            id: promptsArea
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS
            visible: promptsModel.length > 0

            Repeater {
                model: promptsModel

                delegate: Rectangle {
                    required property var modelData
                    required property int index

                    Layout.fillWidth: true
                    implicitHeight: promptColumn.implicitHeight + 2 * SpellUI.SpellTheme.spacingM
                    color: SpellUI.SpellTheme.surfaceHigh
                    radius: SpellUI.SpellTheme.cornerRadius
                    objectName: "promptWidget"

                    property bool answered: modelData.answered || false

                    ColumnLayout {
                        id: promptColumn
                        anchors {
                            fill: parent
                            margins: SpellUI.SpellTheme.spacingM
                        }
                        spacing: SpellUI.SpellTheme.spacingS
                        enabled: !answered

                        // Question text
                        Text {
                            text: modelData.question || ""
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            font.bold: true
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }

                        // Radio type
                        Loader {
                            active: (modelData.type || "radio") === "radio"
                            Layout.fillWidth: true
                            sourceComponent: Column {
                                spacing: SpellUI.SpellTheme.spacingXS
                                ButtonGroup { id: radioGroup }

                                Repeater {
                                    model: modelData.options || []
                                    delegate: RadioButton {
                                        required property var modelData
                                        required property int index
                                        text: modelData
                                        ButtonGroup.group: radioGroup
                                        font.family: SpellUI.SpellTheme.fontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                        onClicked: {
                                            canvasRoot.submitPromptResponse(
                                                promptColumn.parent.modelData.promptId,
                                                modelData,
                                                promptColumn.parent.index
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Checkbox type
                        Loader {
                            active: (modelData.type || "radio") === "checkbox"
                            Layout.fillWidth: true
                            sourceComponent: Column {
                                id: checkboxColumn
                                spacing: SpellUI.SpellTheme.spacingXS

                                property var selected: []

                                Repeater {
                                    model: modelData.options || []
                                    delegate: CheckBox {
                                        required property var modelData
                                        text: modelData
                                        font.family: SpellUI.SpellTheme.fontFamily
                                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                        onToggled: {
                                            var sel = checkboxColumn.selected.slice()
                                            if (checked) {
                                                sel.push(modelData)
                                            } else {
                                                var idx = sel.indexOf(modelData)
                                                if (idx >= 0) sel.splice(idx, 1)
                                            }
                                            checkboxColumn.selected = sel
                                        }
                                    }
                                }

                                Button {
                                    text: "Submit"
                                    onClicked: {
                                        canvasRoot.submitPromptResponse(
                                            promptColumn.parent.modelData.promptId,
                                            checkboxColumn.selected,
                                            promptColumn.parent.index
                                        )
                                    }
                                }
                            }
                        }

                        // Text input type
                        Loader {
                            active: (modelData.type || "radio") === "text"
                            Layout.fillWidth: true
                            sourceComponent: RowLayout {
                                spacing: SpellUI.SpellTheme.spacingS

                                TextField {
                                    id: textInput
                                    Layout.fillWidth: true
                                    placeholderText: "Type your response..."
                                    font.family: SpellUI.SpellTheme.fontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                    color: SpellUI.SpellTheme.textPrimary
                                    background: Rectangle {
                                        color: SpellUI.SpellTheme.surface
                                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                                        border.color: SpellUI.SpellTheme.outline
                                        border.width: 1
                                    }
                                    onAccepted: submitBtn.clicked()
                                }

                                Button {
                                    id: submitBtn
                                    text: "Submit"
                                    onClicked: {
                                        if (textInput.text.length > 0) {
                                            canvasRoot.submitPromptResponse(
                                                promptColumn.parent.modelData.promptId,
                                                textInput.text,
                                                promptColumn.parent.index
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Answered indicator
                        Text {
                            visible: answered
                            text: "Answered"
                            color: SpellUI.SpellTheme.success
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        }
                    }
                }
            }
        }
    }

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object") return
        var action = payload.action
        if (!action) return

        if (action === "set") {
            blocksModel = Array.isArray(payload.content) ? payload.content : []
        } else if (action === "append") {
            var current = blocksModel.slice()
            var newBlocks = Array.isArray(payload.content) ? payload.content : []
            for (var i = 0; i < newBlocks.length; i++) {
                current.push(newBlocks[i])
            }
            blocksModel = current
        } else if (action === "remove") {
            var bid = payload.id
            if (!bid) return
            blocksModel = blocksModel.filter(function(b) { return b.id !== bid })
        } else if (action === "update") {
            var uid = payload.id
            var newData = payload.data
            if (!uid || !newData) return
            var list = blocksModel.slice()
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === uid) {
                    list[i] = { id: uid, type: list[i].type, data: newData }
                    break
                }
            }
            blocksModel = list
        } else if (action === "sync") {
            bridge.send({
                action: "state",
                blocks: blocksModel,
                prompts: promptsModel
            })
        } else if (action === "prompt") {
            handlePrompt(payload)
        }
    }

    function handlePrompt(p) {
        if (!p) return
        var pid = p.promptId
        if (!pid) return

        var entry = {
            promptId: pid,
            type: p.type || "radio",
            question: p.question || "",
            options: Array.isArray(p.options) ? p.options : [],
            answered: false,
            response: null
        }

        var list = promptsModel.slice()
        var existing = -1
        for (var i = 0; i < list.length; i++) {
            if (list[i].promptId === pid) {
                existing = i
                break
            }
        }

        if (existing >= 0) {
            list[existing] = entry
        } else {
            list.push(entry)
        }
        promptsModel = list
    }

    function submitPromptResponse(promptId, value, promptIndex) {
        bridge.send({
            action: "respond",
            promptId: promptId,
            value: value
        })

        // Mark as answered by replacing the entry (triggers binding update)
        var list = promptsModel.slice()
        if (promptIndex >= 0 && promptIndex < list.length) {
            var src = list[promptIndex]
            list[promptIndex] = {
                promptId: src.promptId,
                type: src.type,
                question: src.question,
                options: src.options,
                answered: true,
                response: value
            }
            promptsModel = list
        }
    }
}
