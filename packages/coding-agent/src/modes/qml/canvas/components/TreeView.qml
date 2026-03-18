import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    required property var treeData
    implicitHeight: treeListView.contentHeight

    signal nodeClicked(string nodeId, string label)
    signal nodeExpanded(string nodeId)
    signal nodeCollapsed(string nodeId)

    // expandedIds: set of node IDs that are expanded
    property var expandedIds: ({})

    // Flat list for ListView — [{id, label, icon, depth, hasChildren, isExpanded}]
    property var flatNodes: []

    onTreeDataChanged: rebuildFlatNodes()
    Component.onCompleted: rebuildFlatNodes()

    function rebuildFlatNodes() {
        flatNodes = buildFlatList(treeData ? treeData.nodes || [] : [], 0)
    }

    function buildFlatList(nodes, depth) {
        var result = []
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i]
            var hasChildren = node.children && node.children.length > 0
            var isExp = expandedIds[node.id] !== undefined ? expandedIds[node.id] : (node.expanded || false)
            result.push({
                id: node.id,
                label: node.label || "",
                icon: node.icon || "",
                depth: depth,
                hasChildren: hasChildren,
                isExpanded: isExp
            })
            if (isExp && hasChildren) {
                var children = buildFlatList(node.children, depth + 1)
                for (var j = 0; j < children.length; j++) {
                    result.push(children[j])
                }
            }
        }
        return result
    }

    function toggleNode(nodeId) {
        var node = findNode(treeData ? treeData.nodes || [] : [], nodeId)
        if (!node || !node.children || node.children.length === 0) return

        var ids = Object.assign({}, expandedIds)
        var isCurrentlyExpanded = ids[nodeId] !== undefined ? ids[nodeId] : (node.expanded || false)
        ids[nodeId] = !isCurrentlyExpanded
        expandedIds = ids

        rebuildFlatNodes()

        if (!isCurrentlyExpanded) {
            root.nodeExpanded(nodeId)
        } else {
            root.nodeCollapsed(nodeId)
        }
    }

    function findNode(nodes, targetId) {
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].id === targetId) return nodes[i]
            if (nodes[i].children) {
                var found = findNode(nodes[i].children, targetId)
                if (found) return found
            }
        }
        return null
    }

    // Empty tree placeholder
    Text {
        visible: flatNodes.length === 0
        text: "No items"
        color: SpellUI.SpellTheme.textSecondary
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        anchors.centerIn: parent
        objectName: "emptyPlaceholder"
    }

    ListView {
        id: treeListView
        anchors.fill: parent
        model: flatNodes
        interactive: false
        clip: true

        property int hoveredIndex: -1

        currentIndex: hoveredIndex
        highlightFollowsCurrentItem: true
        highlightMoveDuration: SpellUI.SpellTheme.durationNormal

        highlight: Rectangle {
            visible: treeListView.hoveredIndex >= 0
            color: SpellUI.SpellTheme.surface1
            radius: SpellUI.SpellTheme.cornerRadiusSmall
        }

        delegate: Item {
            required property var modelData
            required property int index

            readonly property bool isFolderNode: modelData.icon === "folder" || modelData.hasChildren

            width: treeListView.width
            height: 36
            objectName: "treeNode_" + modelData.id

            Repeater {
                model: modelData.depth

                Rectangle {
                    width: 1
                    height: parent.height - 10
                    x: 8 + index * 16
                    y: 5
                    color: SpellUI.SpellTheme.borderSubtle
                }
            }

            RowLayout {
                anchors {
                    fill: parent
                    leftMargin: modelData.depth * 16 + 8
                    rightMargin: 8
                }
                spacing: 6

                // Expand/collapse toggle
                Item {
                    width: 16
                    height: 16
                    objectName: modelData.hasChildren ? "treeToggle" : ""

                    Text {
                        anchors.centerIn: parent
                        text: modelData.hasChildren ? "▾" : ""
                        color: SpellUI.SpellTheme.textSecondary
                        font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                        rotation: modelData.isExpanded ? 0 : -90

                        Behavior on rotation {
                            NumberAnimation {
                                duration: 150
                                easing.type: Easing.OutQuad
                            }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        enabled: modelData.hasChildren
                        onClicked: root.toggleNode(modelData.id)
                    }
                }

                Text {
                    text: isFolderNode ? "▪" : "·"
                    color: isFolderNode ? SpellUI.SpellTheme.textSecondary : SpellUI.SpellTheme.textGhost
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    objectName: modelData.icon ? "treeNodeIcon" : ""
                }

                // Label
                Text {
                    text: modelData.label
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: isFolderNode ? SpellUI.SpellTheme.fontWeightMedium : SpellUI.SpellTheme.fontWeightRegular
                    Layout.fillWidth: true
                    objectName: "treeNodeLabel"
                }
            }

            MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                onEntered: treeListView.hoveredIndex = index
                onExited: {
                    if (treeListView.hoveredIndex === index)
                        treeListView.hoveredIndex = -1
                }
                onClicked: root.nodeClicked(modelData.id, modelData.label)
            }
        }
    }
}
