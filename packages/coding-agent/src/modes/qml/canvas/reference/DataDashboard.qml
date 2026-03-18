import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI
import ".."

ApplicationWindow {
    visible: true
    width: windowWidth || 980
    height: windowHeight || 680
    title: windowTitle || "Data Dashboard"
    color: SpellUI.SpellTheme.background

    // Demonstrates armed tool declaration for bridge-side tool invocation.
    property var spellArmedTools: ["write"]

    // Dashboard state used by the markdown summary and table export.
    property string lastUpdated: new Date().toLocaleTimeString()
    property var dashboardRows: [
        { metric: "CPU Usage", value: "72%", status: "Normal", trend: "Up" },
        { metric: "Memory", value: "4.2GB", status: "Warning", trend: "Up" },
        { metric: "Disk I/O", value: "120MB/s", status: "Normal", trend: "Stable" },
        { metric: "Network", value: "45Mbps", status: "Normal", trend: "Down" },
        { metric: "Load Avg", value: "2.1", status: "Normal", trend: "Up" }
    ]

    function summaryMarkdown() {
        return "# System Metrics Dashboard\n" +
               "Last update: **" + lastUpdated + "**\n\n" +
               "- Total metrics: **" + dashboardRows.length + "**\n" +
               "- Warning metrics: **" + dashboardRows.filter(function(r) { return r.status === 'Warning' }).length + "**"
    }

    function tableBlockData() {
        return {
            columns: [
                { key: "metric", label: "Metric", width: 200 },
                { key: "value", label: "Value", width: 120 },
                { key: "status", label: "Status", width: 100 },
                { key: "trend", label: "Trend", width: 100 }
            ],
            rows: dashboardRows,
            sortable: true
        }
    }

    function refreshDashboard() {
        lastUpdated = new Date().toLocaleTimeString()

        // Demonstrates update action by refreshing only one block.
        canvas.handleMessage({
            action: "update",
            id: "dashboard-summary",
            data: { text: summaryMarkdown() }
        })
    }

    function exportDashboardData() {
        if (typeof bridge === "undefined" || !bridge) return

        // Demonstrates armed tool invocation protocol with _tool + _rid.
        bridge.send({
            _tool: "write",
            _rid: "dashboard-export",
            path: "dashboard-export.json",
            content: JSON.stringify({
                exportedAt: new Date().toISOString(),
                rows: dashboardRows
            }, null, 2)
        })
    }

    Component.onCompleted: {
        // Demonstrates set action with markdown + table blocks.
        canvas.handleMessage({
            action: "set",
            content: [
                {
                    id: "dashboard-summary",
                    type: "markdown",
                    data: { text: summaryMarkdown() }
                },
                {
                    id: "system-metrics",
                    type: "table",
                    data: tableBlockData()
                }
            ]
        })
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Demonstrates a custom themed header above AgentCanvas content.
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 56
            color: SpellUI.SpellTheme.surface
            border.color: SpellUI.SpellTheme.outline
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: SpellUI.SpellTheme.spacingL
                anchors.rightMargin: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingM

                Text {
                    text: "System Dashboard"
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
                    font.bold: true
                }

                Rectangle {
                    width: 8
                    height: 8
                    radius: 4
                    color: SpellUI.SpellTheme.success
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    text: "Last refresh: " + lastUpdated
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    Layout.alignment: Qt.AlignVCenter
                }

                Item { Layout.fillWidth: true }

                Button {
                    text: "Refresh"
                    onClicked: refreshDashboard()
                }

                Button {
                    text: "Export"
                    onClicked: exportDashboardData()
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
        target: (typeof bridge !== "undefined") ? bridge : null

        function onMessageReceived(payload) {
            // Keep AgentCanvas protocol wiring intact for set/append/remove/update/sync/prompt.
            canvas.handleMessage(payload)

            // Row clicks are already emitted by AgentCanvas as { action: "event", type: "row_click", data }.
            // Forwarding here demonstrates explicit handling without changing the protocol.
            if (payload && payload.action === "event" && payload.type === "row_click" && typeof bridge !== "undefined" && bridge) {
                bridge.send({ action: "event", type: "dashboard_row_click", data: payload.data })
            }

            // Handle armed-tool write response and show result in markdown.
            if (payload && payload._rid === "dashboard-export") {
                var ok = !(payload.error)
                canvas.handleMessage({
                    action: "append",
                    content: [{
                        id: "export-result-" + Date.now(),
                        type: "markdown",
                        data: {
                            text: ok
                                ? "Export completed: `dashboard-export.json`"
                                : "Export failed: `" + String(payload.error) + "`"
                        }
                    }]
                })
            }
        }
    }

    onClosing: function(close) {
        // Demonstrates close event emission back to the host runtime.
        if (typeof bridge !== "undefined" && bridge)
            bridge.send({ action: "close" })
    }
}
