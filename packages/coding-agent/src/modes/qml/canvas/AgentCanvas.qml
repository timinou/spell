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

    component FocusRing: Rectangle {
        required property bool focused
        required property real baseRadius
        anchors.fill: parent
        anchors.margins: -2
        color: "transparent"
        border.width: 2
        border.color: SpellUI.SpellTheme.primary
        radius: baseRadius + 2
        visible: focused
    }

    component SpellButton: Button {
        id: control
        hoverEnabled: true
        implicitHeight: 36
        implicitWidth: 96
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightMedium
        leftPadding: 16
        rightPadding: 16
        topPadding: 8
        bottomPadding: 8
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        background: Rectangle {
            id: buttonBg
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            border.width: 1
            border.color: control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault
            color: control.down ? SpellUI.SpellTheme.surface2 : SpellUI.SpellTheme.surface1
            scale: control.down ? 0.97 : 1
            transformOrigin: Item.Center

            Behavior on color {
                ColorAnimation {
                    duration: control.down ? SpellUI.SpellTheme.durationFast : 120
                    easing.type: Easing.OutQuad
                }
            }
            Behavior on border.color {
                ColorAnimation {
                    duration: 120
                    easing.type: Easing.OutQuad
                }
            }
            Behavior on scale {
                NumberAnimation {
                    duration: control.down ? SpellUI.SpellTheme.durationFast : 120
                    easing.type: Easing.OutQuad
                }
            }
            FocusRing {
                focused: control.activeFocus
                baseRadius: SpellUI.SpellTheme.cornerRadiusSmall
            }
        }

        contentItem: Text {
            text: control.text
            color: control.enabled ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textSecondary
            font: control.font
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }

    component SpellRadioButton: RadioButton {
        id: control
        spacing: SpellUI.SpellTheme.spacingS
        hoverEnabled: true
        implicitHeight: 24
        leftPadding: indicator.width + spacing + 2
        rightPadding: 0
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        indicator: Rectangle {
            x: 0
            y: (control.height - height) / 2
            implicitWidth: 16
            implicitHeight: 16
            radius: 8
            color: SpellUI.SpellTheme.surface0
            border.width: 2
            border.color: control.checked ? SpellUI.SpellTheme.primary : (control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault)

            Behavior on border.color {
                ColorAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad }
            }

            Rectangle {
                anchors.centerIn: parent
                width: 10
                height: 10
                radius: 5
                color: SpellUI.SpellTheme.primary
                opacity: control.checked ? 1 : 0

                Behavior on opacity {
                    NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad }
                }
            }
        }

        background: Item {}
        contentItem: Text {
            text: control.text
            color: SpellUI.SpellTheme.textPrimary
            font: control.font
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignLeft
            elide: Text.ElideRight
        }
        FocusRing {
            focused: control.activeFocus
            baseRadius: SpellUI.SpellTheme.cornerRadiusSmall
        }
    }

    component SpellCheckBox: CheckBox {
        id: control
        spacing: SpellUI.SpellTheme.spacingS
        hoverEnabled: true
        implicitHeight: 24
        leftPadding: indicator.width + spacing + 2
        rightPadding: 0
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        indicator: Rectangle {
            x: 0
            y: (control.height - height) / 2
            implicitWidth: 16
            implicitHeight: 16
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 2
            border.color: control.checked ? SpellUI.SpellTheme.primary : (control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault)

            Behavior on border.color {
                ColorAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad }
            }

            Text {
                anchors.centerIn: parent
                text: "✓"
                color: SpellUI.SpellTheme.primary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeCaption
                font.weight: SpellUI.SpellTheme.fontWeightBold
                opacity: control.checked ? 1 : 0

                Behavior on opacity {
                    NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad }
                }
            }
        }

        background: Item {}
        contentItem: Text {
            text: control.text
            color: SpellUI.SpellTheme.textPrimary
            font: control.font
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignLeft
            elide: Text.ElideRight
        }
        FocusRing {
            focused: control.activeFocus
            baseRadius: SpellUI.SpellTheme.cornerRadiusSmall
        }
    }

    component SpellTextInput: TextField {
        id: control
        implicitHeight: 36
        leftPadding: 12
        rightPadding: 12
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        color: SpellUI.SpellTheme.textPrimary
        placeholderTextColor: SpellUI.SpellTheme.textTertiary
        background: Rectangle {
            color: SpellUI.SpellTheme.surface0
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            border.width: 1
            border.color: control.activeFocus ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault
            Behavior on border.color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast; easing.type: Easing.OutQuad } }
            FocusRing {
                focused: control.activeFocus
                baseRadius: SpellUI.SpellTheme.cornerRadiusSmall
            }
        }
    }

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
                    id: promptCard
                    required property var modelData
                    required property int index

                    Layout.fillWidth: true
                    implicitHeight: promptColumn.implicitHeight + 32
                    color: SpellUI.SpellTheme.surface1
                    border.color: SpellUI.SpellTheme.borderDefault
                    border.width: 1
                    radius: SpellUI.SpellTheme.cornerRadius
                    objectName: "promptWidget"

                    property bool answered: modelData.answered || false

                    ColumnLayout {
                        id: promptColumn
                        anchors {
                            fill: parent
                            margins: 16
                        }
                        spacing: SpellUI.SpellTheme.spacingS
                        enabled: !promptCard.answered

                        // Question text
                        Text {
                            text: modelData.question || ""
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeL
                            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
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
                                property int hoveredOptionIndex: -1

                                Repeater {
                                    model: modelData.options || []
                                    delegate: Rectangle {
                                        id: radioRow
                                        required property var modelData
                                        required property int index
                                        width: parent ? parent.width : 0
                                        height: radioBtn.implicitHeight + 8
                                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                                        color: hovered ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.08) : "transparent"
                                        opacity: !promptCard.answered || radioBtn.checked ? 1.0 : 0.5
                                        property bool selectedAfterAnswer: promptCard.answered && radioBtn.checked
                                        property bool hovered: parent ? parent.hoveredOptionIndex === index : false

                                        Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationMedium } }
                                        Behavior on color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast } }

                                        Rectangle {
                                            anchors.left: parent.left
                                            anchors.top: parent.top
                                            anchors.bottom: parent.bottom
                                            width: selectedAfterAnswer ? 2 : 0
                                            color: SpellUI.SpellTheme.success
                                            Behavior on width { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal } }
                                        }

                                        MouseArea {
                                            anchors.fill: parent
                                            hoverEnabled: true
                                            enabled: !promptCard.answered
                                            onEntered: parent.parent.hoveredOptionIndex = index
                                            onExited: if (parent.parent.hoveredOptionIndex === index) parent.parent.hoveredOptionIndex = -1
                                            onClicked: radioBtn.clicked()
                                        }

                                        SpellRadioButton {
                                            id: radioBtn
                                            anchors.left: parent.left
                                            anchors.right: parent.right
                                            anchors.verticalCenter: parent.verticalCenter
                                            anchors.leftMargin: SpellUI.SpellTheme.spacingS
                                            anchors.rightMargin: SpellUI.SpellTheme.spacingS
                                            text: modelData
                                            ButtonGroup.group: radioGroup
                                            enabled: !promptCard.answered
                                            onClicked: {
                                                canvasRoot.submitPromptResponse(
                                                    promptCard.modelData.promptId,
                                                    modelData,
                                                    promptCard.index
                                                )
                                            }
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
                                property int hoveredOptionIndex: -1

                                function containsValue(value) {
                                    return selected.indexOf(value) >= 0
                                }

                                Repeater {
                                    model: modelData.options || []
                                    delegate: Rectangle {
                                        id: checkboxRow
                                        required property var modelData
                                        required property int index
                                        width: parent ? parent.width : 0
                                        height: checkBox.implicitHeight + 8
                                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                                        color: hovered ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.08) : "transparent"
                                        property bool isSelected: promptCard.answered ? (Array.isArray(promptCard.modelData.response) && promptCard.modelData.response.indexOf(modelData) >= 0) : checkboxColumn.containsValue(modelData)
                                        property bool hovered: parent ? parent.hoveredOptionIndex === index : false
                                        opacity: !promptCard.answered || isSelected ? 1.0 : 0.5

                                        Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationMedium } }
                                        Behavior on color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast } }

                                        Rectangle {
                                            anchors.left: parent.left
                                            anchors.top: parent.top
                                            anchors.bottom: parent.bottom
                                            width: promptCard.answered && isSelected ? 2 : 0
                                            color: SpellUI.SpellTheme.success
                                            Behavior on width { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal } }
                                        }

                                        MouseArea {
                                            anchors.fill: parent
                                            hoverEnabled: true
                                            enabled: !promptCard.answered
                                            onEntered: parent.parent.hoveredOptionIndex = index
                                            onExited: if (parent.parent.hoveredOptionIndex === index) parent.parent.hoveredOptionIndex = -1
                                            onClicked: checkBox.toggle()
                                        }

                                        SpellCheckBox {
                                            id: checkBox
                                            anchors.left: parent.left
                                            anchors.right: parent.right
                                            anchors.verticalCenter: parent.verticalCenter
                                            anchors.leftMargin: SpellUI.SpellTheme.spacingS
                                            anchors.rightMargin: SpellUI.SpellTheme.spacingS
                                            text: modelData
                                            enabled: !promptCard.answered
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
                                }

                                SpellButton {
                                    text: "Submit"
                                    enabled: checkboxColumn.selected.length > 0 && !promptCard.answered
                                    onClicked: {
                                        canvasRoot.submitPromptResponse(
                                            promptCard.modelData.promptId,
                                            checkboxColumn.selected,
                                            promptCard.index
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

                                SpellTextInput {
                                    id: textInput
                                    Layout.fillWidth: true
                                    placeholderText: "Type your response..."
                                    enabled: !promptCard.answered
                                    onAccepted: submitBtn.clicked()
                                }

                                SpellButton {
                                    id: submitBtn
                                    text: "Submit"
                                    enabled: !promptCard.answered && textInput.text.length > 0
                                    onClicked: {
                                        if (textInput.text.length > 0) {
                                            canvasRoot.submitPromptResponse(
                                                promptCard.modelData.promptId,
                                                textInput.text,
                                                promptCard.index
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Answered indicator
                        Text {
                            visible: promptCard.answered
                            text: "Answered"
                            color: SpellUI.SpellTheme.success
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            font.weight: SpellUI.SpellTheme.fontWeightMedium
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