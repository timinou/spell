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

    function blockStyle(type) {
        if (type === "markdown" || type === "status") {
            return {
                bg: "transparent",
                border: "transparent",
                borderW: 0,
                topHighlight: false
            }
        }

        if (type === "table" || type === "diff" || type === "tree") {
            return {
                bg: SpellUI.SpellTheme.surface0,
                border: SpellUI.SpellTheme.borderDefault,
                borderW: 1,
                topHighlight: true
            }
        }

        if (type === "log") {
            return {
                bg: SpellUI.SpellTheme.background,
                border: SpellUI.SpellTheme.borderSubtle,
                borderW: 1,
                topHighlight: false
            }
        }

        return {
            bg: SpellUI.SpellTheme.surface0,
            border: SpellUI.SpellTheme.borderDefault,
            borderW: 1,
            topHighlight: false
        }
    }

    readonly property var visualStyle: blockStyle(blockType)

    implicitHeight: contentLoader.item ? contentLoader.item.implicitHeight + 32 : 64
    color: visualStyle.bg
    border.color: visualStyle.border
    border.width: visualStyle.borderW
    radius: SpellUI.SpellTheme.cornerRadius
    objectName: "contentBlock_" + blockId

    Rectangle {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: 1
        radius: height / 2
        color: SpellUI.SpellTheme.borderDefault
        visible: visualStyle.topHighlight
    }

    Loader {
        id: contentLoader
        anchors {
            fill: parent
            margins: 16
        }
        sourceComponent: {
            switch (root.blockType) {
                case "markdown": return markdownComponent
                case "image": return imageComponent
                case "table": return tableComponent
                case "diff": return diffComponent
                case "tree": return treeComponent
                case "layout": return layoutComponent
                case "status": return statusComponent
                case "log": return logComponent
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

        // StatusIndicator signals
        function onStatusClicked() {
            root.componentEvent("status_click", {blockId: root.blockId})
        }
    }

    Component {
        id: markdownComponent
        Text {
            text: root.blockData.text || ""
            color: SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
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
        id: layoutComponent
        Components.LayoutContainer {
            layoutData: root.blockData
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: statusComponent
        Components.StatusIndicator {
            statusData: root.blockData
            width: parent ? parent.width : 0
        }
    }

    Component {
        id: logComponent
        Components.LogStream {
            logData: root.blockData
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
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                font.bold: true
                objectName: "blockTypeFallback"
            }

            Text {
                text: JSON.stringify(root.blockData, null, 2)
                color: SpellUI.SpellTheme.textSecondary
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                wrapMode: Text.Wrap
                width: parent ? parent.width : 0
                maximumLineCount: 10
                elide: Text.ElideRight
            }
        }
    }
}