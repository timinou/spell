import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "." as SpellUI
import "./components" as Components

ApplicationWindow {
    id: root

    visible: true
    width: typeof windowWidth === "number" ? windowWidth : 1360
    height: typeof windowHeight === "number" ? windowHeight : 900
    title: typeof windowTitle === "string" ? windowTitle : "Spell Fluid Canvas"
    color: SpellUI.SpellTheme.background

    property string state: "input"
    property bool planReady: false
    property var pendingAgentEvents: []
    property int completedCount: 0
    property int failedCount: 0
    property int totalCount: 0

    ListModel {
        id: agentsModel
    }

    function agentIndexById(agentId) {
        if (!agentId) return -1
        for (var i = 0; i < agentsModel.count; i++) {
            if (agentsModel.get(i).agentId === agentId) return i
        }
        return -1
    }

    function clearAgents() {
        agentsModel.clear()
        completedCount = 0
        failedCount = 0
        totalCount = 0
    }

    function normalizePlanAgents(plan) {
        if (!plan) return []
        if (Array.isArray(plan.agents)) return plan.agents
        if (Array.isArray(plan.nodes)) return plan.nodes
        if (plan.dag && Array.isArray(plan.dag.agents)) return plan.dag.agents
        if (plan.graph && Array.isArray(plan.graph.agents)) return plan.graph.agents
        return []
    }

    function normalizeAgentId(rawAgent, index) {
        if (!rawAgent) return "agent-" + index
        if (rawAgent.id) return String(rawAgent.id)
        if (rawAgent.agentId) return String(rawAgent.agentId)
        if (rawAgent.name) return String(rawAgent.name)
        return "agent-" + index
    }

    function normalizeAgentTask(rawAgent) {
        if (!rawAgent) return ""
        if (rawAgent.task) return String(rawAgent.task)
        if (rawAgent.description) return String(rawAgent.description)
        if (rawAgent.assignment) return String(rawAgent.assignment)
        return ""
    }

    function normalizeBlockData(outputType, payloadContent, outputTitle) {
        if (outputType === "markdown") {
            if (typeof payloadContent === "string") {
                return { text: payloadContent }
            }
            if (!payloadContent || payloadContent.text === undefined) {
                return { text: outputTitle ? String(outputTitle) : "" }
            }
            return payloadContent
        }
        if (typeof payloadContent === "string") {
            return { text: payloadContent }
        }
        return payloadContent || ({})
    }

    function setAgentState(agentId, nextState) {
        var index = agentIndexById(agentId)
        if (index < 0) return
        agentsModel.setProperty(index, "agentState", nextState)
    }

    function appendAgentStream(agentId, text) {
        var index = agentIndexById(agentId)
        if (index < 0) return
        var current = String(agentsModel.get(index).streamText || "")
        agentsModel.setProperty(index, "streamText", current + String(text || ""))
    }

    function setAgentCanvasOutput(agentId, outputType, title, content) {
        var index = agentIndexById(agentId)
        if (index < 0) return
        agentsModel.setProperty(index, "canvasOutput", {
            blockType: outputType || "markdown",
            title: title || "",
            blockData: normalizeBlockData(outputType, content, title)
        })
    }

    function recomputeStatusCounters() {
        var completed = 0
        var failed = 0
        for (var i = 0; i < agentsModel.count; i++) {
            var row = agentsModel.get(i)
            var currentState = row.agentState ? String(row.agentState) : "pending"
            if (currentState === "completed") completed++
            if (currentState === "failed") failed++
        }
        completedCount = completed
        failedCount = failed
        totalCount = agentsModel.count
    }

    function enqueueAgentEvent(payload) {
        var queued = pendingAgentEvents.slice(0)
        queued.push(payload)
        pendingAgentEvents = queued
    }

    function applyAgentEvent(payload) {
        if (!payload || !payload.type) return

        if (payload.type === "fluid:agent_state_change") {
            if (!payload.agentId) return
            if (agentIndexById(payload.agentId) < 0) {
                agentsModel.append({
                    agentId: String(payload.agentId),
                    agentTask: "",
                    agentState: payload.state ? String(payload.state) : "pending",
                    streamText: "",
                    canvasOutput: null
                })
            } else {
                setAgentState(String(payload.agentId), payload.state ? String(payload.state) : "pending")
            }
            recomputeStatusCounters()
            return
        }

        if (payload.type === "fluid:agent_stream") {
            if (!payload.agentId) return
            appendAgentStream(String(payload.agentId), String(payload.text || ""))
            return
        }

        if (payload.type === "fluid:canvas_output") {
            if (!payload.agentId) return
            setAgentCanvasOutput(
                String(payload.agentId),
                payload.outputType ? String(payload.outputType) : "markdown",
                payload.title ? String(payload.title) : "",
                payload.content
            )
        }
    }

    function flushPendingAgentEvents() {
        if (pendingAgentEvents.length === 0) return
        var queued = pendingAgentEvents.slice(0)
        pendingAgentEvents = []
        for (var i = 0; i < queued.length; i++) {
            applyAgentEvent(queued[i])
        }
    }

    function initializePlan(plan) {
        clearAgents()

        var planAgents = normalizePlanAgents(plan)
        for (var i = 0; i < planAgents.length; i++) {
            var rawAgent = planAgents[i]
            agentsModel.append({
                agentId: normalizeAgentId(rawAgent, i),
                agentTask: normalizeAgentTask(rawAgent),
                agentState: "pending",
                streamText: "",
                canvasOutput: null
            })
        }

        totalCount = agentsModel.count
        planReady = true
        state = agentsModel.count === 0 ? "complete" : "executing"
        recomputeStatusCounters()
        flushPendingAgentEvents()
    }

    function submitPrompt() {
        var text = intentField.text ? String(intentField.text).trim() : ""
        if (text.length === 0) return

        bridge.send({ type: "prompt", text: text })
        intentField.text = ""
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            if (!payload || !payload.type) return

            if (payload.type === "fluid:plan_start") {
                planReady = false
                pendingAgentEvents = []
                state = "planning"
                clearAgents()
                return
            }

            if (payload.type === "fluid:plan_complete") {
                initializePlan(payload.plan)
                return
            }

            if (payload.type === "fluid:execution_complete") {
                recomputeStatusCounters()
                state = "complete"
                return
            }

            var isAgentEvent = payload.type === "fluid:agent_state_change"
                || payload.type === "fluid:agent_stream"
                || payload.type === "fluid:canvas_output"

            if (!isAgentEvent) return

            if (!planReady) {
                enqueueAgentEvent(payload)
                return
            }

            applyAgentEvent(payload)
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingXL
        spacing: SpellUI.SpellTheme.spacingL

        StackLayout {
            id: stateStack
            Layout.fillWidth: true
            Layout.fillHeight: true
            currentIndex: {
                if (root.state === "input") return 0
                if (root.state === "planning") return 1
                return 2
            }

            Item {
                ColumnLayout {
                    anchors.centerIn: parent
                    width: Math.min(parent.width * 0.7, 900)
                    spacing: SpellUI.SpellTheme.spacingL

                    Text {
                        Layout.fillWidth: true
                        text: "What do you want to build?"
                        color: SpellUI.SpellTheme.textPrimary
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeXXL
                        font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                        horizontalAlignment: Text.AlignHCenter
                    }

                    TextField {
                        id: intentField
                        Layout.fillWidth: true
                        implicitHeight: 56
                        placeholderText: "Describe your intent"
                        color: SpellUI.SpellTheme.textPrimary
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeL
                        selectByMouse: true

                        background: Rectangle {
                            radius: SpellUI.SpellTheme.cornerRadius
                            color: SpellUI.SpellTheme.surface1
                            border.width: 1
                            border.color: SpellUI.SpellTheme.borderDefault
                        }

                        onAccepted: root.submitPrompt()
                    }

                    Button {
                        Layout.alignment: Qt.AlignHCenter
                        text: "Plan"
                        onClicked: root.submitPrompt()
                    }
                }
            }

            Item {
                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: SpellUI.SpellTheme.spacingM

                    BusyIndicator {
                        Layout.alignment: Qt.AlignHCenter
                        running: true
                    }

                    Text {
                        text: "Planning..."
                        color: SpellUI.SpellTheme.textPrimary
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeXL
                        font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                        horizontalAlignment: Text.AlignHCenter
                    }
                }
            }

            Item {
                ColumnLayout {
                    anchors.fill: parent
                    spacing: SpellUI.SpellTheme.spacingM

                    Rectangle {
                        Layout.fillWidth: true
                        visible: root.state === "complete"
                        color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.success, 0.16)
                        border.width: 1
                        border.color: SpellUI.SpellTheme.success
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        implicitHeight: completionText.implicitHeight + SpellUI.SpellTheme.spacingM * 2

                        Text {
                            id: completionText
                            anchors.centerIn: parent
                            text: "Execution complete"
                            color: SpellUI.SpellTheme.success
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeM
                            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                        }
                    }

                    ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        GridLayout {
                            id: agentGrid
                            width: parent ? parent.width : 0
                            columns: Math.max(1, Math.floor(width / 380))
                            columnSpacing: SpellUI.SpellTheme.spacingM
                            rowSpacing: SpellUI.SpellTheme.spacingM

                            Repeater {
                                model: agentsModel

                                delegate: Components.AgentPanel {
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: 300
                                    Layout.preferredWidth: Math.max(300, (agentGrid.width / agentGrid.columns) - SpellUI.SpellTheme.spacingM)
                                    Layout.preferredHeight: 360

                                    agentId: model.agentId
                                    agentTask: model.agentTask
                                    agentState: model.agentState
                                    streamText: model.streamText
                                    canvasOutput: model.canvasOutput
                                }
                            }
                        }
                    }

                    Components.QueueInspector {
                        Layout.fillWidth: true
                        agents: agentsModel
                        completedCount: root.completedCount
                        totalCount: root.totalCount
                        failedCount: root.failedCount
                    }
                }
            }
        }
    }
}
