import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import ".."

ApplicationWindow {
    visible: true
    width: windowWidth || 1100
    height: windowHeight || 700
    title: windowTitle || "Code Review Surface"
    color: SpellUI.SpellTheme.background

    // Armed tools available to this canvas session.
    property var spellArmedTools: ["write", "read"]

    // Local review state rendered in the markdown summary block.
    property string selectedNodeId: "src/modes/qml/canvas/AgentCanvas.qml"
    property string selectedNodeLabel: "AgentCanvas.qml"
    property string selectedDiffLine: "No line selected yet"

    // Main canvas host: renders blocks and prompts, and accepts protocol messages.
    AgentCanvas {
        id: canvas
        anchors.fill: parent

        // Seed the canvas with a realistic code-review layout.
        blocksModel: [
            {
                id: "reviewSummary",
                type: "markdown",
                data: {
                    text: "# Code Review Session\n" +
                          "Selected file: `" + selectedNodeLabel + "`\n\n" +
                          "Line feedback: " + selectedDiffLine + "\n\n" +
                          "Use the tree to switch files, inspect the diff, then approve or reject."
                }
            },
            {
                id: "fileTree",
                type: "tree",
                data: {
                    nodes: [
                        {
                            id: "src",
                            label: "src",
                            icon: "folder",
                            expanded: true,
                            children: [
                                {
                                    id: "src/modes",
                                    label: "modes",
                                    icon: "folder",
                                    expanded: true,
                                    children: [
                                        {
                                            id: "src/modes/qml",
                                            label: "qml",
                                            icon: "folder",
                                            expanded: true,
                                            children: [
                                                {
                                                    id: "src/modes/qml/canvas",
                                                    label: "canvas",
                                                    icon: "folder",
                                                    expanded: true,
                                                    children: [
                                                        { id: "src/modes/qml/canvas/AgentCanvas.qml", label: "AgentCanvas.qml", icon: "file" },
                                                        { id: "src/modes/qml/canvas/ContentBlock.qml", label: "ContentBlock.qml", icon: "file" },
                                                        { id: "src/modes/qml/canvas/components/DiffView.qml", label: "DiffView.qml", icon: "file" }
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                },
                                {
                                    id: "src/tools",
                                    label: "tools",
                                    icon: "folder",
                                    expanded: false,
                                    children: [
                                        { id: "src/tools/canvas.ts", label: "canvas.ts", icon: "file" }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            },
            {
                id: "reviewDiff",
                type: "diff",
                data: {
                    filename: "src/modes/qml/canvas/AgentCanvas.qml",
                    hunks: [
                        {
                            header: "@@ -214,7 +214,15 @@ function handleMessage(payload) {",
                            lines: [
                                { type: "context", text: "    function handleMessage(payload) {" },
                                { type: "context", text: "        if (!payload || typeof payload !== \"object\") return" },
                                { type: "remove", text: "        var action = payload.action" },
                                { type: "add", text: "        const action = payload.action" },
                                { type: "add", text: "        if (action === \"event\") {" },
                                { type: "add", text: "            handleComponentEvent(payload.type, payload.data)" },
                                { type: "add", text: "            return" },
                                { type: "add", text: "        }" },
                                { type: "context", text: "        if (!action) return" }
                            ]
                        },
                        {
                            header: "@@ -255,0 +263,7 @@",
                            lines: [
                                { type: "add", text: "    function handleComponentEvent(eventType, eventData) {" },
                                { type: "add", text: "        // keeps review telemetry in one place" },
                                { type: "add", text: "        bridge.send({ action: \"event\", type: eventType, data: eventData })" },
                                { type: "add", text: "    }" }
                            ]
                        }
                    ]
                }
            }
        ]

        promptsModel: [
            {
                promptId: "reviewDecision",
                type: "radio",
                question: "Approve this patch?",
                options: ["Approve", "Reject"],
                answered: false,
                response: null
            }
        ]
    }

    // Keep status markdown synchronized with the latest tree/diff interactions.
    function updateReviewSummary() {
        canvas.handleMessage({
            action: "update",
            id: "reviewSummary",
            data: {
                text: "# Code Review Session\n" +
                      "Selected file: `" + selectedNodeLabel + "`\n\n" +
                      "Line feedback: " + selectedDiffLine + "\n\n" +
                      "Use the tree to switch files, inspect the diff, then approve or reject."
            }
        })
    }

    // Bridge message protocol wiring:
    // - inbound actions from host are forwarded to AgentCanvas
    // - event payloads are interpreted to demonstrate review interactions
    Connections {
        target: bridge

        function onMessageReceived(payload) {
            if (!payload || typeof payload !== "object") {
                return
            }

            if (payload.action === "event") {
                if (payload.type === "node_click" && payload.data) {
                    selectedNodeId = payload.data.nodeId || selectedNodeId
                    selectedNodeLabel = payload.data.label || selectedNodeLabel
                    selectedDiffLine = "Browsing file: " + selectedNodeLabel
                    updateReviewSummary()
                } else if (payload.type === "line_click" && payload.data) {
                    var lineType = payload.data.lineType || "context"
                    var lineIndex = payload.data.lineIndex !== undefined ? payload.data.lineIndex : -1
                    selectedDiffLine = "Line " + String(lineIndex + 1) + " (" + lineType + "): " + (payload.data.text || "")
                    updateReviewSummary()
                }
            }

            canvas.handleMessage(payload)
        }
    }

    // Notify the agent runtime when the user closes this window.
    onClosing: function(close) {
        bridge.send({ action: "close" })
    }
}
