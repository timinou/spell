import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

Item {
    id: kanbanBoard

    // campaigns is an array of objects with at minimum: { id, name, clientName, stage }
    // stage must be one of: "planning" | "active" | "paused" | "completed"
    property var campaigns: []

    // Column definitions — order is display order
    readonly property var columns: [
        { key: "planning",  label: "Planning",  color: "#89DCEB" },
        { key: "active",    label: "Active",    color: "#A6E3A1" },
        { key: "paused",    label: "Paused",    color: "#FAB387" },
        { key: "completed", label: "Completed", color: "#6C7086" }
    ]

    // Drag state — tracked at board level so drop targets can read it
    property string dragCampaignId: ""
    property string dragSourceStage: ""

    function campaignsForStage(stage) {
        return kanbanBoard.campaigns.filter(c => c.stage === stage)
    }

    RowLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        Repeater {
            model: kanbanBoard.columns

            delegate: ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 8

                // Column header
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Rectangle {
                        width: 10
                        height: 10
                        radius: 5
                        color: modelData.color
                    }

                    Text {
                        text: modelData.label
                        font.pixelSize: 13
                        font.weight: Font.SemiBold
                        color: "#CDD6F4"
                    }

                    Rectangle {
                        implicitWidth: countLabel.implicitWidth + 10
                        implicitHeight: 18
                        radius: 9
                        color: "#313244"

                        Text {
                            id: countLabel
                            anchors.centerIn: parent
                            text: kanbanBoard.campaignsForStage(modelData.key).length.toString()
                            font.pixelSize: 11
                            color: "#A6ADC8"
                        }
                    }

                    Item { Layout.fillWidth: true }

                    // Add button per column
                    Button {
                        text: "+"
                        implicitWidth: 24
                        implicitHeight: 24
                        flat: true
                        contentItem: Text {
                            text: parent.text
                            font.pixelSize: 16
                            color: "#A6ADC8"
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                        }
                        background: Rectangle { color: "transparent" }
                        onClicked: {
                            if (typeof bridge !== 'undefined') {
                                bridge.send({
                                    type: 'quick_action',
                                    action: 'add_campaign',
                                    stage: modelData.key
                                })
                            }
                        }
                    }
                }

                // Drop target + card list
                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    radius: 8
                    color: dropArea.containsDrag ? "#25253A" : "#181825"
                    border.color: dropArea.containsDrag ? modelData.color : "#313244"
                    border.width: 1

                    Behavior on color { ColorAnimation { duration: 80 } }
                    Behavior on border.color { ColorAnimation { duration: 80 } }

                    // Capture the column key for use in the drop handler closure
                    property string stageKey: modelData.key

                    DropArea {
                        id: dropArea
                        anchors.fill: parent
                        onDropped: (drop) => {
                            const fromStage = kanbanBoard.dragSourceStage
                            const cid = kanbanBoard.dragCampaignId
                            const toStage = parent.stageKey

                            if (cid && fromStage !== toStage) {
                                // Mutate local model optimistically
                                const idx = kanbanBoard.campaigns.findIndex(c => c.id === cid)
                                if (idx !== -1) {
                                    const updated = kanbanBoard.campaigns.slice()
                                    updated[idx] = Object.assign({}, updated[idx], { stage: toStage })
                                    kanbanBoard.campaigns = updated
                                }
                                if (typeof bridge !== 'undefined') {
                                    bridge.send({
                                        type: 'campaign_stage_changed',
                                        campaignId: cid,
                                        fromStage: fromStage,
                                        toStage: toStage
                                    })
                                }
                            }
                            kanbanBoard.dragCampaignId  = ""
                            kanbanBoard.dragSourceStage = ""
                            drop.accept()
                        }
                    }

                    ListView {
                        id: columnList
                        anchors.fill: parent
                        anchors.margins: 8
                        spacing: 8
                        clip: true

                        // Re-derive list each time campaigns changes — keeps binding live
                        model: kanbanBoard.campaignsForStage(parent.stageKey)

                        delegate: Rectangle {
                            id: campaignCard
                            width: columnList.width
                            implicitHeight: cardContent.implicitHeight + 20
                            radius: 6
                            color: dragHandler.active ? "#313244" : "#1E1E2E"
                            border.color: "#313244"
                            border.width: 1
                            opacity: dragHandler.active ? 0.5 : 1.0

                            Drag.active: dragHandler.active
                            Drag.hotSpot.x: width / 2
                            Drag.hotSpot.y: height / 2

                            DragHandler {
                                id: dragHandler
                                onActiveChanged: {
                                    if (active) {
                                        kanbanBoard.dragCampaignId  = modelData.id  || ""
                                        kanbanBoard.dragSourceStage = modelData.stage || ""
                                    }
                                }
                            }

                            ColumnLayout {
                                id: cardContent
                                anchors.left:  parent.left
                                anchors.right: parent.right
                                anchors.top:   parent.top
                                anchors.margins: 10
                                spacing: 4

                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.name || "Untitled Campaign"
                                    font.pixelSize: 13
                                    font.weight: Font.Medium
                                    color: "#CDD6F4"
                                    elide: Text.ElideRight
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.clientName || ""
                                    font.pixelSize: 11
                                    color: "#6C7086"
                                    elide: Text.ElideRight
                                    visible: text !== ""
                                }

                                // Optional: due date or deliverable count
                                RowLayout {
                                    visible: modelData.deliverableCount !== undefined
                                             || modelData.dueDate !== undefined
                                    spacing: 8

                                    Text {
                                        visible: modelData.deliverableCount !== undefined
                                        text: (modelData.deliverableCount || 0).toString() + " deliverables"
                                        font.pixelSize: 11
                                        color: "#CBA6F7"
                                    }

                                    Text {
                                        visible: modelData.dueDate !== undefined && modelData.dueDate
                                        text: modelData.dueDate ? modelData.dueDate.substring(0, 10) : ""
                                        font.pixelSize: 11
                                        color: "#FAB387"
                                    }
                                }
                            }

                            MouseArea {
                                anchors.fill: parent
                                // Propagate to DragHandler; single click opens detail
                                onClicked: {
                                    if (typeof bridge !== 'undefined') {
                                        bridge.send({
                                            type: 'campaign_selected',
                                            campaignId: modelData.id || ""
                                        })
                                    }
                                }
                            }
                        }

                        // Empty column placeholder
                        Text {
                            anchors.centerIn: parent
                            visible: columnList.count === 0
                            text: "Drop here"
                            font.pixelSize: 12
                            color: "#45475A"
                        }
                    }
                }
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'campaigns_data') {
                kanbanBoard.campaigns = payload.campaigns || []
            }
        }
    }

    Component.onCompleted: {
        if (typeof bridge !== 'undefined') {
            bridge.send({ type: 'panel_ready', panelId: 'kanban' })
        }
    }
}
