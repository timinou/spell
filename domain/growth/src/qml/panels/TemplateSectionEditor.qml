import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// Editable list of template sections.
// Emits bridge events:
//   section_add    {}
//   section_remove { sectionId }
//   section_edit   { sectionId }
//   section_move   { sectionId, fromIndex, toIndex }
Item {
    id: root

    // Populated by host: [{ id, type, title, components: [...] }]
    property var sections: []

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 8
        spacing: 8

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: "Sections"
                font.pixelSize: 13
                font.weight: Font.SemiBold
                color: "#CDD6F4"
                Layout.fillWidth: true
            }

            Button {
                text: "+ Add"
                flat: true
                contentItem: Text {
                    text: parent.text
                    font.pixelSize: 12
                    color: "#7C3AED"
                }
                background: Rectangle {
                    radius: 4
                    color: parent.hovered ? "#313244" : "transparent"
                    border.color: "#7C3AED"
                    border.width: 1
                }
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'section_add' })
                    }
                }
            }
        }

        ListView {
            id: listView
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 4
            clip: true
            model: root.sections

            // Drag reorder support
            moveDisplaced: Transition {
                NumberAnimation { properties: "y"; duration: 150 }
            }

            delegate: Item {
                id: delegateRoot
                width: listView.width
                height: 56

                // Drag handle state
                property bool dragging: false

                Rectangle {
                    anchors.fill: parent
                    radius: 6
                    color: delegateRoot.dragging ? "#45475A" : "#1E1E2E"
                    border.color: "#45475A"
                    border.width: 1

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 8
                        anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 8

                        // Drag handle
                        Text {
                            text: "⠿"
                            font.pixelSize: 16
                            color: "#6C7086"

                            MouseArea {
                                anchors.fill: parent
                                drag.target: delegateRoot
                                drag.axis: Drag.YAxis
                                onPressed: delegateRoot.dragging = true
                                onReleased: {
                                    delegateRoot.dragging = false
                                    const newIdx = Math.floor((delegateRoot.y + delegateRoot.height / 2) / delegateRoot.height)
                                    const clampedIdx = Math.max(0, Math.min(newIdx, root.sections.length - 1))
                                    if (clampedIdx !== index && typeof bridge !== 'undefined') {
                                        bridge.send({
                                            type: 'section_move',
                                            sectionId: modelData.id,
                                            fromIndex: index,
                                            toIndex: clampedIdx
                                        })
                                    }
                                    delegateRoot.y = 0
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2

                            Text {
                                Layout.fillWidth: true
                                text: modelData.title || ""
                                font.pixelSize: 12
                                font.weight: Font.Medium
                                color: "#CDD6F4"
                                elide: Text.ElideRight
                            }

                            Text {
                                text: (modelData.type || "") + " · " + (modelData.components ? modelData.components.length : 0) + " component(s)"
                                font.pixelSize: 11
                                color: "#A6ADC8"
                            }
                        }

                        Button {
                            text: "Edit"
                            flat: true
                            contentItem: Text {
                                text: parent.text
                                font.pixelSize: 11
                                color: "#CDD6F4"
                                horizontalAlignment: Text.AlignHCenter
                            }
                            background: Rectangle {
                                radius: 4
                                color: parent.hovered ? "#313244" : "#2A2A3E"
                                border.color: "#45475A"
                                border.width: 1
                            }
                            implicitWidth: 48
                            implicitHeight: 28
                            onClicked: {
                                if (typeof bridge !== 'undefined') {
                                    bridge.send({ type: 'section_edit', sectionId: modelData.id })
                                }
                            }
                        }

                        Button {
                            text: "✕"
                            flat: true
                            contentItem: Text {
                                text: parent.text
                                font.pixelSize: 11
                                color: "#F38BA8"
                                horizontalAlignment: Text.AlignHCenter
                            }
                            background: Rectangle {
                                radius: 4
                                color: parent.hovered ? "#3B1E1E" : "transparent"
                            }
                            implicitWidth: 28
                            implicitHeight: 28
                            onClicked: {
                                if (typeof bridge !== 'undefined') {
                                    bridge.send({ type: 'section_remove', sectionId: modelData.id })
                                }
                            }
                        }
                    }
                }
            }

            Text {
                anchors.centerIn: parent
                visible: listView.count === 0
                text: "No sections — click + Add to start"
                font.pixelSize: 12
                color: "#6C7086"
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'sections_update') {
                root.sections = payload.sections || []
            }
        }
    }
}
