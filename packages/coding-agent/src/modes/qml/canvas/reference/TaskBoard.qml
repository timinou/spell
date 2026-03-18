import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import ".."

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 650
    title: windowTitle || "Task Board"
    color: SpellUI.SpellTheme.background

    // Arm org tool to support task creation/workflow actions from this canvas.
    property var spellArmedTools: ["org"]

    // Task metadata keyed by tree node id for fast detail lookup on click.
    property var taskDetailsById: ({
        "proj-alpha": {
            title: "Project Alpha",
            owner: "Program Team",
            status: "Active",
            summary: "Delivery plan for design and build milestones.",
            notes: "Expand phases to review individual tasks."
        },
        "phase-design": {
            title: "Phase 1: Design",
            owner: "Architecture",
            status: "In Progress",
            summary: "Define interfaces and expectations before implementation.",
            notes: "Design tasks should complete before core build starts."
        },
        "task-define-api": {
            title: "Task: Define API",
            owner: "A. Chen",
            status: "In Review",
            summary: "Draft endpoint contracts, request/response schemas, and error model.",
            notes: "Pending approval from backend and client leads."
        },
        "task-write-specs": {
            title: "Task: Write specs",
            owner: "M. Patel",
            status: "Ready",
            summary: "Write acceptance criteria and non-functional requirements.",
            notes: "Specs become source of truth for implementation tests."
        },
        "phase-build": {
            title: "Phase 2: Build",
            owner: "Implementation",
            status: "Planned",
            summary: "Deliver core behavior and verification coverage.",
            notes: "Depends on design phase sign-off."
        },
        "task-implement-core": {
            title: "Task: Implement core",
            owner: "J. Kim",
            status: "Planned",
            summary: "Implement service core paths and integration boundaries.",
            notes: "Track blockers as org notes during execution."
        },
        "task-add-tests": {
            title: "Task: Add tests",
            owner: "R. Gomez",
            status: "Planned",
            summary: "Add regression and edge-case tests for core workflows.",
            notes: "Batch complete operation can be used after pass criteria is met."
        }
    })

    AgentCanvas {
        id: canvas
        anchors.fill: parent
    }

    Component.onCompleted: {
        // Seed the board with hierarchy + detail pane blocks.
        canvas.handleMessage({
            action: "set",
            content: [
                {
                    id: "task-tree",
                    type: "tree",
                    data: {
                        nodes: [
                            {
                                id: "proj-alpha",
                                label: "Project Alpha",
                                icon: "folder",
                                expanded: true,
                                children: [
                                    {
                                        id: "phase-design",
                                        label: "Phase 1 (Design)",
                                        icon: "folder",
                                        expanded: true,
                                        children: [
                                            { id: "task-define-api", label: "Task: Define API", icon: "file" },
                                            { id: "task-write-specs", label: "Task: Write specs", icon: "file" }
                                        ]
                                    },
                                    {
                                        id: "phase-build",
                                        label: "Phase 2 (Build)",
                                        icon: "folder",
                                        expanded: true,
                                        children: [
                                            { id: "task-implement-core", label: "Task: Implement core", icon: "file" },
                                            { id: "task-add-tests", label: "Task: Add tests", icon: "file" }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                },
                {
                    id: "task-detail",
                    type: "markdown",
                    data: {
                        text: "## Task Details\n\nSelect a node in the task tree to inspect details here."
                    }
                }
            ]
        })

        // Prompt can be replaced later using the same promptId via protocol action: "prompt".
        canvas.handleMessage({
            action: "prompt",
            promptId: "batch-complete",
            type: "checkbox",
            question: "Select tasks to mark complete",
            options: [
                "Task: Define API",
                "Task: Write specs",
                "Task: Implement core",
                "Task: Add tests"
            ]
        })
    }

    function detailMarkdownFor(nodeId, label) {
        var detail = taskDetailsById[nodeId]
        if (!detail) {
            return "## Task Details\n\nUnknown selection: **" + (label || nodeId || "(none)") + "**"
        }

        return "## " + detail.title + "\n\n"
            + "- **Owner:** " + detail.owner + "\n"
            + "- **Status:** " + detail.status + "\n\n"
            + detail.summary + "\n\n"
            + "_" + detail.notes + "_"
    }

    function handleCanvasEvent(eventPayload) {
        if (!eventPayload || eventPayload.type !== "node_click" || !eventPayload.data) {
            return
        }

        var selectedId = eventPayload.data.nodeId || ""
        var selectedLabel = eventPayload.data.label || ""

        // Update detail markdown on node click. Tree expand/collapse state is internal to TreeView,
        // so selection details remain stable when users toggle branches.
        canvas.handleMessage({
            action: "update",
            id: "task-detail",
            data: {
                text: detailMarkdownFor(selectedId, selectedLabel)
            }
        })
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            // Standard AgentCanvas protocol handling.
            canvas.handleMessage(payload)

            // Handle event payloads (for node_click) to drive task detail pane updates.
            if (payload && payload.action === "event") {
                handleCanvasEvent(payload)
            }
        }
    }

    onClosing: function(close) {
        bridge.send({ action: "close" })
    }
}
