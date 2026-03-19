import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Rectangle {
    id: root

    property var agentsModel: null
    property var dependsOnByAgentId: ({})
    property string selectedAgentId: ""

    signal nodeActivated(string agentId)

    radius: SpellUI.SpellTheme.cornerRadiusSmall
    color: SpellUI.SpellTheme.surface1
    border.width: 1
    border.color: SpellUI.SpellTheme.borderSubtle
    implicitHeight: 220

    function agentCount() {
        return agentsModel ? agentsModel.count : 0
    }

    function agentRowAt(index) {
        if (!agentsModel || index < 0 || index >= agentsModel.count) return null
        return agentsModel.get(index)
    }

    function agentIdAt(index) {
        var row = agentRowAt(index)
        return row && row.agentId ? String(row.agentId) : ""
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

    function dependsOn(agentId) {
        return materializeDependsOn(dependsOnByAgentId[agentId])
    }

    function agentState(agentId) {
        if (!agentsModel) return "pending"
        for (var i = 0; i < agentsModel.count; i++) {
            var row = agentsModel.get(i)
            if (String(row.agentId) === agentId) {
                return row.agentState ? String(row.agentState) : "pending"
            }
        }
        return "pending"
    }

    function stateColor(state) {
        switch (state) {
        case "ready": return "#388BFD"
        case "running": return SpellUI.SpellTheme.warning
        case "completed": return SpellUI.SpellTheme.success
        case "failed": return SpellUI.SpellTheme.error
        default: return SpellUI.SpellTheme.textTertiary
        }
    }

    function nodeLevel(agentId, visiting) {
        if (!agentId) return 0
        var marker = visiting || ({})
        if (marker[agentId]) return 0
        marker[agentId] = true

        var deps = dependsOn(agentId)
        var maxDepLevel = -1
        for (var i = 0; i < deps.length; i++) {
            maxDepLevel = Math.max(maxDepLevel, nodeLevel(String(deps[i]), marker))
        }
        return maxDepLevel + 1
    }

    function nodeLane(index) {
        var id = agentIdAt(index)
        if (!id) return 0
        var level = nodeLevel(id, {})
        var lane = 0
        for (var i = 0; i < index; i++) {
            var prevId = agentIdAt(i)
            if (!prevId) continue
            if (nodeLevel(prevId, {}) === level) lane++
        }
        return lane
    }

    function maxLevel() {
        var max = 0
        for (var i = 0; i < agentCount(); i++) {
            max = Math.max(max, nodeLevel(agentIdAt(i), {}))
        }
        return max
    }

    function maxLane() {
        var max = 0
        for (var i = 0; i < agentCount(); i++) {
            max = Math.max(max, nodeLane(i))
        }
        return max
    }

    function findNodeItem(agentId) {
        if (!agentId) return null
        for (var i = 0; i < nodeRepeater.count; i++) {
            var item = nodeRepeater.itemAt(i)
            if (item && item.nodeId === agentId) return item
        }
        return null
    }

    Flickable {
        id: graphFlick
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingS
        clip: true

        contentWidth: Math.max(width, (root.maxLevel() + 1) * 230 + 120)
        contentHeight: Math.max(height, (root.maxLane() + 1) * 90 + 80)

        Canvas {
            id: edgeCanvas
            width: graphFlick.contentWidth
            height: graphFlick.contentHeight

            onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                ctx.strokeStyle = SpellUI.SpellTheme.borderDefault
                ctx.lineWidth = 1.5

                for (var i = 0; i < nodeRepeater.count; i++) {
                    var target = nodeRepeater.itemAt(i)
                    if (!target) continue

                    var deps = root.dependsOn(target.nodeId)
                    for (var j = 0; j < deps.length; j++) {
                        var source = root.findNodeItem(String(deps[j]))
                        if (!source) continue
                        ctx.beginPath()
                        ctx.moveTo(source.x + source.width, source.y + source.height / 2)
                        ctx.lineTo(target.x, target.y + target.height / 2)
                        ctx.stroke()
                    }
                }
            }
        }

        Repeater {
            id: nodeRepeater
            model: root.agentCount()

            delegate: Rectangle {
                id: nodeCard

                property string nodeId: root.agentIdAt(index)
                property int level: root.nodeLevel(nodeId, {})
                property int lane: root.nodeLane(index)
                property string nodeState: root.agentState(nodeId)

                x: level * 230 + 30
                y: lane * 90 + 30
                width: 190
                height: 64
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: SpellUI.SpellTheme.surface0
                border.width: root.selectedAgentId === nodeId ? 2 : 1
                border.color: root.selectedAgentId === nodeId
                    ? root.stateColor(nodeState)
                    : SpellUI.SpellTheme.borderDefault

                Rectangle {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: 4
                    radius: 2
                    color: root.stateColor(nodeState)
                }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 12
                    anchors.rightMargin: 10
                    anchors.topMargin: 8
                    anchors.bottomMargin: 8
                    spacing: 2

                    Text {
                        Layout.fillWidth: true
                        text: nodeId
                        color: SpellUI.SpellTheme.textPrimary
                        font.family: SpellUI.SpellTheme.monoFontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: nodeState
                        color: root.stateColor(nodeState)
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                        font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                        elide: Text.ElideRight
                    }
                }

                MouseArea {
                    anchors.fill: parent
                    onClicked: root.nodeActivated(nodeId)
                }
            }
        }

        Timer {
            interval: 250
            repeat: true
            running: root.visible
            onTriggered: edgeCanvas.requestPaint()
        }
    }
}
