import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "./components" as Components

Rectangle {
    id: root

    required property string blockId
    required property string blockType
    required property var blockData

    signal componentEvent(string eventType, var eventData)

    implicitHeight: contentLoader.item ? contentLoader.item.implicitHeight + 16 : 48
    color: SpellUI.SpellTheme.surface
    radius: SpellUI.SpellTheme.cornerRadius
    objectName: "contentBlock_" + blockId

    Loader {
        id: contentLoader
        anchors {
            fill: parent
            margins: 8
        }
        sourceComponent: {
            switch (root.blockType) {
                case "markdown": return markdownComponent
                case "image": return imageComponent
                case "table": return tableComponent
                case "diff": return diffComponent
                case "tree": return treeComponent
                default: return fallbackComponent
            }
        }
    }

    Connections {
        target: contentLoader.item
        ignoreUnknownSignals: true

        // DataTable signals
        function onRowClicked(rowIndex, rowData) {
            root.componentEvent("row_click", {blockId: root.blockId, rowIndex: rowIndex, rowData: rowData})
        }
        function onSortChanged(key, ascending) {
            root.componentEvent("sort_change", {blockId: root.blockId, key: key, ascending: ascending})
        }
        function onCellSelected(rowIndex, colKey) {
            root.componentEvent("cell_select", {blockId: root.blockId, rowIndex: rowIndex, colKey: colKey})
        }

        // DiffView signals
        function onLineClicked(lineIndex, lineType, text) {
            root.componentEvent("line_click", {blockId: root.blockId, lineIndex: lineIndex, lineType: lineType, text: text})
        }
        function onHunkApproved(hunkIndex) {
            root.componentEvent("hunk_approve", {blockId: root.blockId, hunkIndex: hunkIndex})
        }
        function onHunkRejected(hunkIndex) {
            root.componentEvent("hunk_reject", {blockId: root.blockId, hunkIndex: hunkIndex})
        }

        // TreeView signals
        function onNodeClicked(nodeId, label) {
            root.componentEvent("node_click", {blockId: root.blockId, nodeId: nodeId, label: label})
        }
        function onNodeExpanded(nodeId) {
            root.componentEvent("node_expand", {blockId: root.blockId, nodeId: nodeId})
        }
        function onNodeCollapsed(nodeId) {
            root.componentEvent("node_collapse", {blockId: root.blockId, nodeId: nodeId})
        }
    }

    Component {
        id: markdownComponent
        Text {
            text: root.blockData.text || ""
            color: SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            wrapMode: Text.Wrap
            width: parent ? parent.width : 0
            textFormat: Text.MarkdownText
        }
    }

    Component {
        id: imageComponent
        Image {
            source: root.blockData.url || root.blockData.src || ""
            fillMode: Image.PreserveAspectFit
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: tableComponent
        Components.DataTable {
            tableData: root.blockData
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: diffComponent
        Components.DiffView {
            diffData: root.blockData
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: treeComponent
        Components.TreeView {
            treeData: root.blockData
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: fallbackComponent
        Column {
            spacing: 4
            width: parent ? parent.width : 0

            Text {
                text: "[" + root.blockType + "]"
                color: SpellUI.SpellTheme.primary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                font.bold: true
                objectName: "blockTypeFallback"
            }

            Text {
                text: JSON.stringify(root.blockData, null, 2)
                color: SpellUI.SpellTheme.textSecondary
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                wrapMode: Text.Wrap
                width: parent ? parent.width : 0
                maximumLineCount: 10
                elide: Text.ElideRight
            }
        }
    }
}
