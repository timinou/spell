import QtQuick 2.15
import QtQuick.Controls 2.15
import "../.." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 600
    height: windowHeight || 600
    title: "TreeView Test"
    color: SpellUI.SpellTheme.background

    property var lastNodeClick: null
    property var lastExpandEvent: null
    property var lastCollapseEvent: null

    TreeView {
        id: treeView
        anchors.fill: parent
        treeData: currentTreeData
        onNodeClicked: function(id, label) { lastNodeClick = {id: id, label: label} }
        onNodeExpanded: function(id) { lastExpandEvent = id }
        onNodeCollapsed: function(id) { lastCollapseEvent = id }
    }

    property var currentTreeData: null

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === "query") {
                handleQuery(payload)
            } else if (payload.type === "reset") {
                currentTreeData = null
                lastNodeClick = null
                lastExpandEvent = null
                lastCollapseEvent = null
                treeView.expandedIds = ({})
                bridge.send({ type: "reset_done" })
            } else if (payload.type === "set_tree") {
                currentTreeData = payload.data
            } else if (payload.type === "toggle_node") {
                treeView.toggleNode(payload.nodeId)
            } else if (payload.type === "emit_click") {
                treeView.nodeClicked(payload.nodeId, payload.label)
            }
        }
    }

    function handleQuery(payload) {
        var queryName = payload.query
        var result = null
        if (queryName === "visibleNodeCount") {
            result = treeView.flatNodes.length
        } else if (queryName === "lastNodeClick") {
            result = lastNodeClick
        } else if (queryName === "lastExpandEvent") {
            result = lastExpandEvent
        } else if (queryName === "lastCollapseEvent") {
            result = lastCollapseEvent
        } else if (queryName.indexOf("isExpanded?") === 0) {
            var nodeId = queryName.substring("isExpanded?".length)
            for (var i = 0; i < treeView.flatNodes.length; i++) {
                if (treeView.flatNodes[i].id === nodeId) {
                    result = treeView.flatNodes[i].isExpanded
                    break
                }
            }
        }
        bridge.send({ type: "query_response", query: queryName, result: result })
    }
}
