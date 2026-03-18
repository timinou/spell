import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import ".."

ApplicationWindow {
    id: root

    visible: true
    width: windowWidth || 1000
    height: windowHeight || 600
    title: windowTitle || "Agent Monitor"
    color: SpellUI.SpellTheme.background

    // Observation-only canvas: no armed tools, no tool extraction.
    property var spellArmedTools: []

    property string selectedAgentId: "agent-101"
    property string lastUpdated: "Waiting for first update..."
    property var agentRows: [
        {
            id: "agent-101",
            name: "Planner",
            status: "running",
            task: "Synthesizing architecture options",
            tokens: 11840,
            output: "### Planner\n- Reviewing module boundaries\n- Comparing state synchronization approaches\n- Preparing recommendation"
        },
        {
            id: "agent-202",
            name: "Reviewer",
            status: "completed",
            task: "Audited bridge message handling",
            tokens: 7642,
            output: "### Reviewer\nAudit complete.\n\n- No protocol mismatches found\n- Suggested stronger payload validation on `update` messages"
        },
        {
            id: "agent-303",
            name: "Implementer",
            status: "pending",
            task: "Awaiting assignment",
            tokens: 0,
            output: "### Implementer\nNo output yet. Agent is pending dispatch."
        }
    ]

    function formatTimestamp(dateObj) {
        var pad = function(num) { return num < 10 ? "0" + num : String(num) }
        return dateObj.getFullYear()
            + "-" + pad(dateObj.getMonth() + 1)
            + "-" + pad(dateObj.getDate())
            + " " + pad(dateObj.getHours())
            + ":" + pad(dateObj.getMinutes())
            + ":" + pad(dateObj.getSeconds())
    }

    function normalizeRows(rows) {
        if (!Array.isArray(rows)) return []
        var normalized = []
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i] || {}
            normalized.push({
                id: r.id || "agent-" + (i + 1),
                name: r.name || "Unnamed",
                status: r.status || "pending",
                task: r.task || "No task",
                tokens: r.tokens !== undefined ? r.tokens : 0,
                output: r.output || "No output available."
            })
        }
        return normalized
    }

    function selectedOutput() {
        for (var i = 0; i < agentRows.length; i++) {
            if (agentRows[i].id === selectedAgentId) {
                return agentRows[i].output
            }
        }
        return "### No agent selected\nSelect a row in the table to inspect latest output."
    }

    function refreshBlocks() {
        canvas.blocksModel = [
            {
                id: "agents-table",
                type: "table",
                data: {
                    columns: [
                        { key: "id", label: "ID", width: 80 },
                        { key: "name", label: "Name", width: 150 },
                        { key: "status", label: "Status", width: 100 },
                        { key: "task", label: "Task", width: 250 },
                        { key: "tokens", label: "Tokens", width: 80 }
                    ],
                    rows: agentRows,
                    sortable: true
                }
            },
            {
                id: "latest-output",
                type: "markdown",
                data: {
                    text: selectedOutput()
                }
            }
        ]
    }

    function applyMonitorUpdate(payload) {
        if (!payload || typeof payload !== "object") return

        if (Array.isArray(payload.rows)) {
            agentRows = normalizeRows(payload.rows)
            if (agentRows.length > 0) {
                var stillPresent = false
                for (var i = 0; i < agentRows.length; i++) {
                    if (agentRows[i].id === selectedAgentId) {
                        stillPresent = true
                        break
                    }
                }
                if (!stillPresent) selectedAgentId = agentRows[0].id
            }
        }

        if (payload.selectedAgentId) {
            selectedAgentId = payload.selectedAgentId
        }

        refreshBlocks()
    }

    Component.onCompleted: {
        lastUpdated = formatTimestamp(new Date())
        refreshBlocks()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingL
        spacing: SpellUI.SpellTheme.spacingM

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 48
            radius: SpellUI.SpellTheme.cornerRadius
            color: SpellUI.SpellTheme.surfaceHigh
            border.color: SpellUI.SpellTheme.outline
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingM

                Text {
                    text: "Agent Monitor"
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                    font.bold: true
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: "Last updated: " + lastUpdated
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                }
            }
        }

        AgentCanvas {
            id: canvas
            Layout.fillWidth: true
            Layout.fillHeight: true
        }
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            // Auto-refresh pattern: every incoming message (including silent periodic updates)
            // refreshes the timestamp so operators can confirm the monitor is still receiving traffic.
            lastUpdated = formatTimestamp(new Date())

            if (payload && payload.action === "event" && payload.type === "row_click") {
                var row = payload.data && payload.data.rowData ? payload.data.rowData : null
                if (row && row.id) {
                    selectedAgentId = row.id
                    refreshBlocks()
                }
                return
            }

            // Convention for monitor feeds: periodic `update` messages carry fresh rows.
            if (payload && payload.action === "update" && payload.id === "agents-table") {
                applyMonitorUpdate(payload.data || {})
                return
            }

            canvas.handleMessage(payload)
        }
    }

    onClosing: function(close) {
        bridge.send({ action: "close" })
    }
}
