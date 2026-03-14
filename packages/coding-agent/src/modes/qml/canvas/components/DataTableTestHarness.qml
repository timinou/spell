import QtQuick 2.15
import QtQuick.Controls 2.15
import "../.." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 600
    title: windowTitle || "DataTable Test"
    color: SpellUI.SpellTheme.background

    // Track events for testing
    property var lastRowClick: null
    property var lastSortChange: null
    property var currentTableData: null

    DataTable {
        id: table
        anchors.fill: parent
        anchors.margins: 16
        tableData: currentTableData

        onRowClicked: function(idx, row) {
            lastRowClick = { index: idx, row: row }
        }

        onSortChanged: function(key, asc) {
            lastSortChange = { key: key, ascending: asc }
        }

        onCellSelected: function(idx, colKey) {
            // reserved for future use
        }
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            if (payload.type === "query") {
                handleQuery(payload)
            } else if (payload.type === "reset") {
                currentTableData = null
                lastRowClick = null
                lastSortChange = null
                table.sortKey = ""
                table.sortAsc = true
                bridge.send({ type: "reset_done" })
            } else if (payload.type === "set_data") {
                currentTableData = payload.data
            } else if (payload.type === "simulate_row_click") {
                var idx = payload.index
                table.rowClicked(idx, table.sortedRows[idx])
            } else if (payload.type === "simulate_sort_click") {
                var key = payload.key
                if (table.sortKey === key) {
                    table.sortAsc = !table.sortAsc
                } else {
                    table.sortKey = key
                    table.sortAsc = true
                }
                table.sortChanged(table.sortKey, table.sortAsc)
            }
        }
    }

    function handleQuery(payload) {
        var queryName = payload.query
        var result = null

        if (queryName === "rowCount") {
            result = currentTableData ? (currentTableData.rows || []).length : 0
        } else if (queryName === "columnCount") {
            result = currentTableData ? (currentTableData.columns || []).length : 0
        } else if (queryName === "lastRowClick") {
            result = lastRowClick
        } else if (queryName === "lastSortChange") {
            result = lastSortChange
        } else if (queryName === "sortKey") {
            result = table.sortKey
        } else if (queryName === "sortAsc") {
            result = table.sortAsc
        }

        bridge.send({ type: "query_response", query: queryName, result: result })
    }
}
