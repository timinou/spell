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
    property string lastError: ""
    property string planningStreamText: ""
    property double planningStartedAt: 0
    property int planningElapsedSeconds: 0
    property bool showPlanningFallback: false
    property var dependsOnByAgentId: ({})
    property string selectedRetryAgentId: ""
    property var executionSummary: ({ total: 0, completed: 0, failed: 0, elapsedSeconds: 0 })

    ListModel {
        id: agentsModel
        dynamicRoles: true
    }

    Timer {
        id: planningTimer
        interval: 250
        repeat: true
        running: root.state === "planning"
        onTriggered: {
            if (root.planningStartedAt <= 0) return
            var elapsedMs = Date.now() - root.planningStartedAt
            root.planningElapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
            root.showPlanningFallback = root.planningStreamText.length === 0 && elapsedMs >= 2000
        }
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
        dependsOnByAgentId = ({})
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

    function normalizeDependsOn(rawAgent) {
        if (!rawAgent || !Array.isArray(rawAgent.dependsOn)) return []
        var deps = []
        for (var i = 0; i < rawAgent.dependsOn.length; i++) {
            deps.push(String(rawAgent.dependsOn[i]))
        }
        return deps
    }

    function materializeDependsOn(value) {
        if (Array.isArray(value)) return value
        if (value && typeof value.length === "number") {
            var deps = []
            for (var i = 0; i < value.length; i++) {
                deps.push(String(value[i]))
            }
            return deps
        }
        return []
    }

    function formatDuration(totalSeconds) {
        var safe = Math.max(0, Number(totalSeconds) || 0)
        var mins = Math.floor(safe / 60)
        var secs = safe % 60
        return mins + "m " + (secs < 10 ? "0" : "") + secs + "s"
    }

    function resetExecutionSummary() {
        executionSummary = ({ total: 0, completed: 0, failed: 0, elapsedSeconds: 0 })
    }

    function setExecutionSummaryFromResults(results) {
        if (!Array.isArray(results)) {
            executionSummary = ({
                total: totalCount,
                completed: completedCount,
                failed: failedCount,
                elapsedSeconds: 0
            })
            return
        }

        var completed = 0
        var failed = 0
        var minStartedAt = 0
        var maxCompletedAt = 0
        for (var i = 0; i < results.length; i++) {
            var item = results[i] || ({})
            var state = item.state ? String(item.state) : "pending"
            if (state === "completed") completed++
            if (state === "failed") failed++

            var startedAt = Number(item.startedAt || 0)
            var completedAt = Number(item.completedAt || 0)
            if (startedAt > 0 && (minStartedAt === 0 || startedAt < minStartedAt)) {
                minStartedAt = startedAt
            }
            if (completedAt > maxCompletedAt) {
                maxCompletedAt = completedAt
            }
        }

        var elapsedSeconds = 0
        if (minStartedAt > 0 && maxCompletedAt >= minStartedAt) {
            elapsedSeconds = Math.floor((maxCompletedAt - minStartedAt) / 1000)
        }

        executionSummary = ({
            total: results.length,
            completed: completed,
            failed: failed,
            elapsedSeconds: elapsedSeconds
        })
    }

    function appendPlanningStream(text) {
        var chunk = String(text || "")
        if (chunk.length === 0) return
        if (planningStreamText.length === 0) {
            planningStreamText = chunk
        } else {
            planningStreamText += "\n" + chunk
        }
        showPlanningFallback = false
    }

    function resetPlanningState() {
        planningStreamText = ""
        planningStartedAt = Date.now()
        planningElapsedSeconds = 0
        showPlanningFallback = false
    }

    function resetToInput() {
        state = "input"
        planReady = false
        pendingAgentEvents = []
        planningStreamText = ""
        planningStartedAt = 0
        planningElapsedSeconds = 0
        showPlanningFallback = false
        selectedRetryAgentId = ""
        resetExecutionSummary()
        clearAgents()
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

        if (outputType === "code") {
            if (typeof payloadContent === "string") {
                return { code: payloadContent, html: "", language: "text" }
            }
            if (!payloadContent) {
                return { code: "", html: "", language: "text" }
            }

            var normalizedCode = payloadContent.code !== undefined
                ? String(payloadContent.code)
                : (payloadContent.text !== undefined ? String(payloadContent.text) : "")

            return {
                code: normalizedCode,
                html: payloadContent.html !== undefined && payloadContent.html !== null ? String(payloadContent.html) : "",
                language: payloadContent.language ? String(payloadContent.language) : "text"
            }
        }

        if (outputType === "progress") {
            if (typeof payloadContent === "number") {
                return { value: payloadContent, max: 100, label: outputTitle ? String(outputTitle) : "Progress" }
            }
            if (typeof payloadContent === "string") {
                var parsed = Number(payloadContent)
                if (isFinite(parsed)) {
                    return { value: parsed, max: 100, label: outputTitle ? String(outputTitle) : "Progress" }
                }
                return { value: -1, max: 100, label: payloadContent }
            }
            if (!payloadContent) {
                return { value: 0, max: 100, label: outputTitle ? String(outputTitle) : "Progress" }
            }
            var normalizedValue = payloadContent.value !== undefined ? Number(payloadContent.value) : 0
            return {
                value: isFinite(normalizedValue) ? normalizedValue : 0,
                max: payloadContent.max !== undefined && isFinite(Number(payloadContent.max)) ? Number(payloadContent.max) : 100,
                label: payloadContent.label !== undefined && payloadContent.label !== null
                    ? String(payloadContent.label)
                    : (outputTitle ? String(outputTitle) : "Progress")
            }
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

    function setAgentError(agentId, nextError) {
        var index = agentIndexById(agentId)
        if (index < 0) return
        agentsModel.setProperty(index, "agentError", nextError || "")
    }

    function setAgentTiming(agentId, startedAt, completedAt) {
        var index = agentIndexById(agentId)
        if (index < 0) return
        if (startedAt !== undefined && startedAt !== null) {
            agentsModel.setProperty(index, "startedAt", Number(startedAt))
        }
        if (completedAt !== undefined && completedAt !== null) {
            agentsModel.setProperty(index, "completedAt", Number(completedAt))
        }
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

    function refreshDependencyStatuses() {
        for (var i = 0; i < agentsModel.count; i++) {
            var row = agentsModel.get(i)
            var agentId = String(row.agentId || "")
            var deps = materializeDependsOn(dependsOnByAgentId[agentId])
            if (deps.length === 0) {
                agentsModel.setProperty(i, "dependencyStatus", "")
                continue
            }

            var completedDeps = 0
            var failedDeps = 0
            var missingDeps = 0
            for (var j = 0; j < deps.length; j++) {
                var depId = String(deps[j])
                var depIndex = agentIndexById(depId)
                if (depIndex < 0) {
                    missingDeps++
                    continue
                }
                var depState = String(agentsModel.get(depIndex).agentState || "pending")
                if (depState === "completed") completedDeps++
                if (depState === "failed") failedDeps++
            }

            var status = "Dependencies: " + completedDeps + "/" + deps.length + " complete"
            if (failedDeps > 0) {
                status = "Dependencies: failed"
            } else if (missingDeps > 0) {
                status = status + " (" + missingDeps + " missing)"
            } else if (completedDeps === deps.length) {
                status = "Dependencies: satisfied"
            }
            agentsModel.setProperty(i, "dependencyStatus", status)
        }
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
            var agentId = String(payload.agentId)
            var nextState = payload.state ? String(payload.state) : "pending"
            var nextError = payload.error ? String(payload.error) : ""
            if (agentIndexById(agentId) < 0) {
                agentsModel.append({
                    agentId: agentId,
                    agentTask: "",
                    agentState: nextState,
                    streamText: "",
                    agentError: nextError,
                    dependencyStatus: "",
                    dependsOn: [],
                    startedAt: payload.startedAt !== undefined ? Number(payload.startedAt) : 0,
                    completedAt: payload.completedAt !== undefined ? Number(payload.completedAt) : 0,
                    canvasOutput: null
                })
            } else {
                setAgentState(agentId, nextState)
                setAgentError(agentId, nextError)
                setAgentTiming(agentId, payload.startedAt, payload.completedAt)
            }
            recomputeStatusCounters()
            refreshDependencyStatuses()
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
        var nextDependsOnById = ({})
        for (var i = 0; i < planAgents.length; i++) {
            var rawAgent = planAgents[i]
            var agentId = normalizeAgentId(rawAgent, i)
            var dependsOn = normalizeDependsOn(rawAgent)
            nextDependsOnById[agentId] = dependsOn
            agentsModel.append({
                agentId: agentId,
                agentTask: normalizeAgentTask(rawAgent),
                agentState: "pending",
                streamText: "",
                agentError: "",
                dependencyStatus: "",
                dependsOn: dependsOn,
                startedAt: 0,
                completedAt: 0,
                canvasOutput: null
            })
        }
        dependsOnByAgentId = nextDependsOnById

        totalCount = agentsModel.count
        planReady = true
        state = agentsModel.count === 0 ? "complete" : "executing"
        selectedRetryAgentId = ""
        resetExecutionSummary()
        refreshDependencyStatuses()
        recomputeStatusCounters()
        flushPendingAgentEvents()
    }

    function submitPrompt() {
        if (root.state !== "input") return
        root.lastError = ""
        var text = intentField.text ? String(intentField.text).trim() : ""
        if (text.length === 0) return

        bridge.send({ type: "prompt", text: text })
        intentField.text = ""
    }

    function requestCancel(reason) {
        if (root.state !== "planning" && root.state !== "executing") return
        bridge.send({
            type: "cancel_execution",
            reason: reason ? String(reason) : "Cancelled by user"
        })
    }

    function failedAgentIds() {
        var ids = []
        for (var i = 0; i < agentsModel.count; i++) {
            var row = agentsModel.get(i)
            if (String(row.agentState || "pending") === "failed") {
                ids.push(String(row.agentId))
            }
        }
        return ids
    }

    function requestRetryFailed() {
        if (root.state !== "complete") return
        var retryIds = []
        if (selectedRetryAgentId.length > 0) {
            var selectedIndex = agentIndexById(selectedRetryAgentId)
            if (selectedIndex >= 0 && String(agentsModel.get(selectedIndex).agentState || "") === "failed") {
                retryIds.push(selectedRetryAgentId)
            }
        }
        if (retryIds.length === 0) {
            retryIds = failedAgentIds()
        }
        if (retryIds.length === 0) return

        root.lastError = ""
        selectedRetryAgentId = ""
        bridge.send({ type: "retry_failed", agentIds: retryIds })
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            if (!payload || !payload.type) return

            if (payload.type === "fluid:plan_start") {
                planReady = false
                pendingAgentEvents = []
                clearAgents()
                resetExecutionSummary()
                resetPlanningState()
                state = "planning"
                return
            }

            if (payload.type === "fluid:planner_stream") {
                appendPlanningStream(payload.text)
                return
            }

            if (payload.type === "fluid:plan_complete") {
                root.lastError = ""
                planningStartedAt = 0
                initializePlan(payload.plan)
                return
            }

            if (payload.type === "fluid:plan_error") {
                root.lastError = payload.error ? String(payload.error) : "Planning failed"
                resetToInput()
                return
            }

            if (payload.type === "fluid:execution_cancelled") {
                root.lastError = payload.reason ? String(payload.reason) : "Execution cancelled"
                resetToInput()
                return
            }

            if (payload.type === "fluid:execution_complete") {
                recomputeStatusCounters()
                setExecutionSummaryFromResults(payload.results)
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

    onPlanningStreamTextChanged: {
        Qt.callLater(function () {
            var bottom = planningStreamFlick.contentHeight - planningStreamFlick.height
            planningStreamFlick.contentY = Math.max(0, bottom)
        })
    }

    Shortcut {
        sequence: "Escape"
        enabled: root.state === "planning" || root.state === "executing"
        onActivated: root.requestCancel("Cancelled from keyboard")
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

                    Text {
                        Layout.fillWidth: true
                        text: root.lastError
                        visible: root.lastError.length > 0
                        color: SpellUI.SpellTheme.error
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeM
                        wrapMode: Text.WordWrap
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
                    anchors.fill: parent
                    anchors.margins: SpellUI.SpellTheme.spacingXL
                    spacing: SpellUI.SpellTheme.spacingM

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: SpellUI.SpellTheme.spacingM

                        Text {
                            Layout.fillWidth: true
                            text: "Planning..."
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXL
                            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                        }

                        Button {
                            text: "Cancel"
                            onClicked: root.requestCancel("Cancelled during planning")
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Elapsed " + root.formatDuration(root.planningElapsedSeconds)
                        color: SpellUI.SpellTheme.textSecondary
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        radius: SpellUI.SpellTheme.cornerRadius
                        color: SpellUI.SpellTheme.surface0
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        BusyIndicator {
                            anchors.centerIn: parent
                            visible: root.showPlanningFallback
                            running: visible
                        }

                        Text {
                            anchors.centerIn: parent
                            visible: root.planningStreamText.length === 0 && !root.showPlanningFallback
                            text: "Waiting for planner output..."
                            color: SpellUI.SpellTheme.textTertiary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        }

                        Flickable {
                            id: planningStreamFlick
                            anchors.fill: parent
                            anchors.margins: SpellUI.SpellTheme.spacingM
                            clip: true
                            visible: root.planningStreamText.length > 0
                            contentWidth: width
                            contentHeight: planningStreamLabel.paintedHeight

                            TextEdit {
                                id: planningStreamLabel
                                width: planningStreamFlick.width
                                readOnly: true
                                text: root.planningStreamText
                                color: SpellUI.SpellTheme.textSecondary
                                font.family: SpellUI.SpellTheme.monoFontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                                wrapMode: TextEdit.WrapAnywhere
                                selectByMouse: true
                            }
                        }
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

                    Rectangle {
                        visible: root.state === "complete"
                        Layout.fillWidth: true
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: SpellUI.SpellTheme.surface1
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle
                        implicitHeight: summaryText.implicitHeight + SpellUI.SpellTheme.spacingM * 2

                        Text {
                            id: summaryText
                            anchors.centerIn: parent
                            text: "Summary: " + root.executionSummary.completed + "/" + root.executionSummary.total
                                + " completed, " + root.executionSummary.failed + " failed, elapsed "
                                + root.formatDuration(root.executionSummary.elapsedSeconds)
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                        }
                    }

                    Components.DagGraph {
                        Layout.fillWidth: true
                        Layout.preferredHeight: 220
                        agentsModel: agentsModel
                        dependsOnByAgentId: root.dependsOnByAgentId
                        selectedAgentId: root.selectedRetryAgentId
                        onNodeActivated: function(agentId) {
                            var index = root.agentIndexById(agentId)
                            if (index < 0) return
                            if (String(agentsModel.get(index).agentState || "") !== "failed") {
                                root.selectedRetryAgentId = ""
                                return
                            }
                            root.selectedRetryAgentId = root.selectedRetryAgentId === agentId ? "" : agentId
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: SpellUI.SpellTheme.spacingS

                        Item {
                            Layout.fillWidth: true
                        }

                        Button {
                            visible: root.state === "executing"
                            text: "Cancel"
                            onClicked: root.requestCancel("Cancelled during execution")
                        }

                        Button {
                            visible: root.state === "complete" && root.failedCount > 0
                            text: root.selectedRetryAgentId.length > 0
                                ? ("Retry " + root.selectedRetryAgentId + " Subtree")
                                : "Retry Failed Subtree"
                            onClicked: root.requestRetryFailed()
                        }

                        Button {
                            visible: root.state === "complete"
                            text: "New Prompt"
                            onClicked: {
                                root.lastError = ""
                                resetToInput()
                                intentField.forceActiveFocus()
                            }
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
                                    Layout.preferredHeight: implicitHeight

                                    agentId: model.agentId
                                    agentTask: model.agentTask
                                    agentState: model.agentState
                                    streamText: model.streamText
                                    canvasOutput: model.canvasOutput
                                    errorText: model.agentError
                                    dependencyStatus: model.dependencyStatus
                                    startedAt: model.startedAt
                                    completedAt: model.completedAt
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
