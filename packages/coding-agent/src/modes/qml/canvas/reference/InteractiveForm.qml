import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import ".."

ApplicationWindow {
    id: root

    visible: true
    width: windowWidth || 800
    height: windowHeight || 700
    title: windowTitle || "Canvas Reference: Interactive Form"
    color: SpellUI.SpellTheme.background

    // Armed tool example: request a file read for input-validation context.
    property var spellArmedTools: ["read"]

    // _rid correlation id for tool round-trip demonstration.
    property string validationRid: "interactive-form-validation-read"
    property string validationStatus: "Validation context: pending..."

    AgentCanvas {
        id: canvas
        anchors.fill: parent
    }

    function formSummaryMarkdown(): string {
        function promptById(promptId) {
            for (var i = 0; i < canvas.promptsModel.length; i++) {
                if (canvas.promptsModel[i].promptId === promptId)
                    return canvas.promptsModel[i]
            }
            return null
        }

        var namePrompt = promptById("name")
        var languagePrompt = promptById("language")
        var featuresPrompt = promptById("features")

        var nameValue = namePrompt && namePrompt.answered ? String(namePrompt.response) : "_(not submitted yet)_"
        var languageValue = languagePrompt && languagePrompt.answered ? String(languagePrompt.response) : "_(not submitted yet)_"
        var featuresValue = "_(not submitted yet)_"

        if (featuresPrompt && featuresPrompt.answered) {
            var selected = featuresPrompt.response
            if (Array.isArray(selected) && selected.length > 0) {
                featuresValue = selected.join(", ")
            } else {
                featuresValue = "_(submitted with no features selected)_"
            }
        }

        return [
            "## Form Result",
            "",
            "- **Name:** " + nameValue,
            "- **Preferred language:** " + languageValue,
            "- **Selected features:** " + featuresValue,
            "",
            "_" + validationStatus + "_"
        ].join("\n")
    }

    function refreshResultBlock() {
        canvas.handleMessage({
            action: "update",
            id: "result",
            data: {
                text: formSummaryMarkdown()
            }
        })
    }

    function initializeCanvas() {
        canvas.handleMessage({
            action: "set",
            content: [
                {
                    id: "header",
                    type: "markdown",
                    data: {
                        text: "# Interactive Form Reference\nThis canvas demonstrates all prompt types at once (text, radio, checkbox), prompt replacement, and armed-tool _rid correlation. Fill the prompts below to see the result area update."
                    }
                },
                {
                    id: "result",
                    type: "markdown",
                    data: {
                        text: formSummaryMarkdown()
                    }
                }
            ]
        })

        canvas.handleMessage({
            action: "prompt",
            promptId: "name",
            type: "text",
            question: "Enter your name"
        })

        canvas.handleMessage({
            action: "prompt",
            promptId: "language",
            type: "radio",
            question: "Select preferred language",
            options: ["TypeScript", "Python", "Rust", "Go"]
        })

        canvas.handleMessage({
            action: "prompt",
            promptId: "features",
            type: "checkbox",
            question: "Select features",
            options: ["Logging", "Testing", "CI/CD", "Docker", "Monitoring"]
        })

        // Prompt replacement pattern: same promptId replaces the existing prompt in place.
        canvas.handleMessage({
            action: "prompt",
            promptId: "language",
            type: "radio",
            question: "Select preferred language (replacement prompt)",
            options: ["TypeScript", "Python", "Rust", "Go"]
        })

        // _rid round-trip pattern: tool request includes _rid; tool response echoes same _rid.
        bridge.send({
            _tool: "read",
            _rid: validationRid,
            path: "package.json"
        })
    }

    Connections {
        target: canvas

        function onPromptsModelChanged() {
            refreshResultBlock()
        }
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            // Keep default wiring so AgentCanvas can process protocol actions.
            canvas.handleMessage(payload)

            // _rid correlation handling for armed tool callbacks.
            if (payload && payload._rid === validationRid) {
                if (payload.error) {
                    validationStatus = "Validation context read failed: " + String(payload.error)
                } else {
                    validationStatus = "Validation context loaded from package.json via armed read tool"
                }
                refreshResultBlock()
            }
        }
    }

    Component.onCompleted: initializeCanvas()

    onClosing: function(close) {
        bridge.send({ action: "close" })
    }
}
