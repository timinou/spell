import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var tableData
    implicitHeight: tableLayout.implicitHeight

    // Sort state
    property string sortKey: ""
    property bool sortAsc: true

    // Computed sorted rows
    property var sortedRows: {
        if (!tableData || !tableData.rows) return []
        if (!sortKey) return tableData.rows
        var rows = tableData.rows.slice()
        var key = sortKey
        var asc = sortAsc
        rows.sort(function(a, b) {
            var av = a[key]
            var bv = b[key]
            if (av < bv) return asc ? -1 : 1
            if (av > bv) return asc ? 1 : -1
            return 0
        })
        return rows
    }

    signal rowClicked(int rowIndex, var rowData)
    signal sortChanged(string key, bool ascending)
    signal cellSelected(int rowIndex, string colKey)

    ColumnLayout {
        id: tableLayout
        anchors.fill: parent
        spacing: 0

        // Header row
        Row {
            id: headerRow
            Layout.fillWidth: true

            Repeater {
                model: root.tableData ? root.tableData.columns : []

                delegate: Rectangle {
                    required property var modelData
                    required property int index

                    width: modelData.width || 120
                    height: 32
                    color: SpellUI.SpellTheme.surfaceHigh
                    objectName: "columnHeader_" + modelData.key

                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: 4

                        Text {
                            text: modelData.label || modelData.key
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            font.bold: true
                            Layout.fillWidth: true
                        }

                        Text {
                            visible: root.tableData && root.tableData.sortable === true && root.sortKey === modelData.key
                            text: root.sortAsc ? "▲" : "▼"
                            color: SpellUI.SpellTheme.primary
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        enabled: root.tableData && root.tableData.sortable === true

                        onClicked: {
                            var k = modelData.key
                            if (root.sortKey === k) {
                                root.sortAsc = !root.sortAsc
                            } else {
                                root.sortKey = k
                                root.sortAsc = true
                            }
                            root.sortChanged(k, root.sortAsc)
                        }
                    }
                }
            }
        }

        // Data rows
        ListView {
            id: tableView
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: root.sortedRows
            clip: true

            delegate: Rectangle {
                id: rowDelegate

                required property var modelData
                required property int index

                width: tableView.width
                height: 36
                objectName: "tableRow"

                // Capture for inner Repeater access
                property var rowData: modelData
                property int rowIdx: index

                color: {
                    if (root.tableData && root.tableData.highlightRow === index)
                        return Qt.rgba(232/255, 160/255, 64/255, 0.15)
                    return index % 2 === 0 ? SpellUI.SpellTheme.surface : SpellUI.SpellTheme.surfaceHigh
                }

                Row {
                    anchors.fill: parent

                    Repeater {
                        model: root.tableData ? root.tableData.columns : []

                        delegate: Item {
                            required property var modelData
                            width: modelData.width || 120
                            height: 36

                            Text {
                                anchors.fill: parent
                                anchors.margins: 4
                                text: {
                                    var col = modelData.key
                                    var row = rowDelegate.rowData
                                    return (row && col && row[col] !== undefined) ? String(row[col]) : ""
                                }
                                color: SpellUI.SpellTheme.textPrimary
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                verticalAlignment: Text.AlignVCenter
                            }
                        }
                    }
                }

                MouseArea {
                    anchors.fill: parent
                    onClicked: root.rowClicked(rowDelegate.rowIdx, rowDelegate.rowData)
                }
            }
        }
    }
}
