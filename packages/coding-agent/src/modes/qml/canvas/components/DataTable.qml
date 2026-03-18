import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var tableData
    implicitHeight: headerHeight + bodyHeight

    // Sort state
    property string sortKey: ""
    property bool sortAsc: true

    // Lightweight hover tracking
    property int hoveredColumnIndex: -1
    property int hoveredRowIndex: -1

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

    readonly property int headerHeight: 38
    readonly property int rowHeight: 40
    readonly property int maxVisibleRows: 10
    readonly property int bodyHeight: {
        var visibleRows = sortedRows.length > 0 ? Math.min(sortedRows.length, maxVisibleRows) : 1
        return visibleRows * rowHeight + 1
    }

    signal rowClicked(int rowIndex, var rowData)
    signal sortChanged(string key, bool ascending)
    signal cellSelected(int rowIndex, string colKey)

    function isSortableColumn(column) {
        return root.tableData && root.tableData.sortable === true && column && column.key
    }

    function baseColumnWidth(column) {
        return (column && column.width && column.width > 0) ? column.width : 120
    }

    function columnWidth(columnIndex, column, totalWidth) {
        var columns = root.tableData ? root.tableData.columns || [] : []
        if (columns.length === 0)
            return baseColumnWidth(column)

        var minWidth = baseColumnWidth(column)
        var isLast = columnIndex === columns.length - 1
        if (!isLast)
            return minWidth

        var consumed = 0
        for (var i = 0; i < columns.length - 1; i++)
            consumed += baseColumnWidth(columns[i])

        var available = Math.floor(totalWidth - consumed)
        return Math.max(minWidth, available)
    }

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

                    width: root.columnWidth(index, modelData, headerRow.width)
                    height: 38
                    color: root.hoveredColumnIndex === index ? SpellUI.SpellTheme.surface2 : SpellUI.SpellTheme.surface1
                    objectName: "columnHeader_" + modelData.key

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        spacing: 8

                        Text {
                            text: modelData.label || modelData.key
                            color: SpellUI.SpellTheme.textPrimary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            font.weight: SpellUI.SpellTheme.fontWeightMedium
                            font.letterSpacing: SpellUI.SpellTheme.trackingWide
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                            verticalAlignment: Text.AlignVCenter
                        }

                        Text {
                            visible: root.isSortableColumn(modelData)
                            text: "▾"
                            color: SpellUI.SpellTheme.primary
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            opacity: root.sortKey === modelData.key ? 1 : 0
                            rotation: root.sortAsc ? 0 : 180

                            Behavior on rotation {
                                NumberAnimation {
                                    duration: 100
                                    easing.type: Easing.OutQuad
                                }
                            }

                            Behavior on opacity {
                                NumberAnimation {
                                    duration: SpellUI.SpellTheme.durationFast
                                    easing.type: Easing.OutQuad
                                }
                            }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        enabled: true
                        hoverEnabled: true
                        cursorShape: root.isSortableColumn(modelData) ? Qt.PointingHandCursor : Qt.ArrowCursor

                        onEntered: root.hoveredColumnIndex = index
                        onExited: {
                            if (root.hoveredColumnIndex === index)
                                root.hoveredColumnIndex = -1
                        }

                        onClicked: {
                            if (!root.isSortableColumn(modelData))
                                return
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

        // Data rows in recessed well
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: root.bodyHeight
            color: SpellUI.SpellTheme.background
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            clip: true

            ListView {
                id: tableView
                anchors.fill: parent
                model: root.sortedRows
                clip: true

                delegate: Item {
                    id: rowDelegate

                    required property var modelData
                    required property int index

                    width: tableView.width
                    height: 40
                    objectName: "tableRow"

                    // Capture for inner Repeater access
                    property var rowData: modelData
                    property int rowIdx: index

                    Rectangle {
                        anchors.fill: parent
                        color: {
                            if (root.tableData && root.tableData.highlightRow === rowDelegate.rowIdx)
                                return SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.15)
                            if (root.hoveredRowIndex === rowDelegate.rowIdx)
                                return SpellUI.SpellTheme.surface1
                            return SpellUI.SpellTheme.surface0
                        }
                        Behavior on color {
                            enabled: rowDelegate.rowIdx === root.hoveredRowIndex || (root.tableData && root.tableData.highlightRow === rowDelegate.rowIdx) || color !== SpellUI.SpellTheme.surface0
                            ColorAnimation {
                                duration: 120
                                easing.type: Easing.OutQuad
                            }
                        }
                    }

                    Rectangle {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        height: 1
                        color: SpellUI.SpellTheme.borderSubtle
                    }

                    Row {
                        anchors.fill: parent

                        Repeater {
                            model: root.tableData ? root.tableData.columns : []

                            delegate: Item {
                                required property var modelData
                                required property int index

                                width: root.columnWidth(index, modelData, rowDelegate.width)
                                height: rowDelegate.height

                                Text {
                                    anchors.left: parent.left
                                    anchors.right: parent.right
                                    anchors.top: parent.top
                                    anchors.bottom: parent.bottom
                                    anchors.leftMargin: 12
                                    anchors.rightMargin: 12
                                    anchors.topMargin: 8
                                    anchors.bottomMargin: 8
                                    text: {
                                        var col = modelData.key
                                        var row = rowDelegate.rowData
                                        return (row && col && row[col] !== undefined) ? String(row[col]) : ""
                                    }
                                    color: SpellUI.SpellTheme.textPrimary
                                    font.family: SpellUI.SpellTheme.fontFamily
                                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                                    font.weight: SpellUI.SpellTheme.fontWeightRegular
                                    verticalAlignment: Text.AlignVCenter
                                    elide: Text.ElideRight
                                }
                            }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true

                        onEntered: root.hoveredRowIndex = rowDelegate.rowIdx
                        onExited: {
                            if (root.hoveredRowIndex === rowDelegate.rowIdx)
                                root.hoveredRowIndex = -1
                        }

                        onClicked: root.rowClicked(rowDelegate.rowIdx, rowDelegate.rowData)
                    }
                }
            }

            Text {
                visible: tableView.count === 0
                anchors.centerIn: parent
                text: "No rows"
                color: SpellUI.SpellTheme.textTertiary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                objectName: "emptyPlaceholder"
            }
        }
    }
}
