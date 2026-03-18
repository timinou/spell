import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var layoutData
    implicitHeight: {
        if (direction === "row") return rowLayout.implicitHeight
        if (direction === "grid") return gridLayout.implicitHeight
        return columnLayout.implicitHeight
    }

    property string direction: {
        if (!layoutData || !layoutData.direction) return "column"
        return layoutData.direction
    }
    property int spacing: (layoutData && layoutData.spacing !== undefined) ? layoutData.spacing : SpellUI.SpellTheme.spacingS
    property int gridColumns: Math.max(1, (layoutData && layoutData.columns) ? layoutData.columns : 2)
    property var childrenData: (layoutData && layoutData.children) ? layoutData.children : []

    property var contentBlockComponent: null
    property int contentBlockStatus: Component.Null

    function loadContentBlockComponent() {
        var component = Qt.createComponent("../ContentBlock.qml")
        contentBlockComponent = component
        contentBlockStatus = component.status
    }

    Component.onCompleted: loadContentBlockComponent()

    Component {
        id: childBlockDelegate

        Item {
            id: delegateRoot

            required property var modelData
            required property int index

            property var blockInstance: null
            property real flex: {
                var value = modelData && modelData.flex
                return (typeof value === "number" && value > 0) ? value : 1
            }

            Layout.fillWidth: true
            Layout.fillHeight: false
            Layout.preferredWidth: root.direction === "row" ? flex : -1

            implicitHeight: blockInstance ? blockInstance.implicitHeight : 0
            height: implicitHeight

            function createChildBlock() {
                destroyChildBlock()
                if (root.contentBlockStatus !== Component.Ready || !root.contentBlockComponent) return

                var childId = modelData && modelData.id ? modelData.id : ("child_" + index)
                var childType = modelData && modelData.type ? modelData.type : "markdown"
                var childData = modelData && modelData.data ? modelData.data : {}

                blockInstance = root.contentBlockComponent.createObject(delegateRoot, {
                    blockId: childId,
                    blockType: childType,
                    blockData: childData,
                    x: 0,
                    y: 0,
                    width: delegateRoot.width
                })
            }

            function destroyChildBlock() {
                if (!blockInstance) return
                blockInstance.destroy()
                blockInstance = null
            }

            onWidthChanged: {
                if (blockInstance) blockInstance.width = width
            }

            Connections {
                target: root.contentBlockComponent
                ignoreUnknownSignals: true

                function onStatusChanged() {
                    root.contentBlockStatus = root.contentBlockComponent.status
                    if (root.contentBlockStatus === Component.Ready) {
                        delegateRoot.createChildBlock()
                    }
                }
            }

            Component.onCompleted: createChildBlock()
            Component.onDestruction: destroyChildBlock()
        }
    }

    RowLayout {
        id: rowLayout
        anchors.fill: parent
        spacing: root.spacing
        visible: root.direction === "row"

        Repeater {
            model: root.childrenData
            delegate: childBlockDelegate
        }
    }

    ColumnLayout {
        id: columnLayout
        anchors.fill: parent
        spacing: root.spacing
        visible: root.direction !== "row" && root.direction !== "grid"

        Repeater {
            model: root.childrenData
            delegate: childBlockDelegate
        }
    }

    GridLayout {
        id: gridLayout
        anchors.fill: parent
        columns: root.gridColumns
        columnSpacing: root.spacing
        rowSpacing: root.spacing
        visible: root.direction === "grid"

        Repeater {
            model: root.childrenData
            delegate: childBlockDelegate
        }
    }
}
