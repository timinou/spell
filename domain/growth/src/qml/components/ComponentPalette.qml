import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// Grid of available brand components.
// Drag a tile to add it to a section, or click to emit component_pick.
// Bridge events emitted:
//   component_pick { componentType }
Item {
    id: root

    // Each entry: { type: string, label: string, icon: string }
    property var components: [
        { type: "stat-cell",      label: "Stat Cell",      icon: "📊" },
        { type: "section-header", label: "Section Header", icon: "📌" },
        { type: "metric-strip",   label: "Metric Strip",   icon: "📈" },
        { type: "callout-box",    label: "Callout Box",    icon: "💬" },
        { type: "page-footer",    label: "Page Footer",    icon: "📄" },
        { type: "text-block",     label: "Text Block",     icon: "✏️" },
        { type: "table",          label: "Table",          icon: "🗂️" }
    ]

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 8
        spacing: 8

        Text {
            text: "Components"
            font.pixelSize: 13
            font.weight: Font.SemiBold
            color: "#CDD6F4"
        }

        GridView {
            id: grid
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            // Two columns; tiles are square-ish
            cellWidth:  (grid.width - 4) / 2
            cellHeight: 72

            model: root.components

            delegate: Item {
                id: tile
                width:  grid.cellWidth  - 4
                height: grid.cellHeight - 4

                // Drag metadata — received by the drop target via Drag.mimeData
                Drag.active: dragArea.drag.active
                Drag.hotSpot.x: width  / 2
                Drag.hotSpot.y: height / 2
                Drag.mimeData: ({ "application/x-component-type": modelData.type })

                states: State {
                    name: "dragging"
                    when: tile.Drag.active
                    PropertyChanges { target: tile; opacity: 0.6 }
                }

                Rectangle {
                    anchors.fill: parent
                    radius: 6
                    color: dragArea.containsMouse ? "#313244" : "#1E1E2E"
                    border.color: dragArea.containsMouse ? "#7C3AED" : "#45475A"
                    border.width: 1

                    ColumnLayout {
                        anchors.centerIn: parent
                        spacing: 4

                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: modelData.icon || ""
                            font.pixelSize: 20
                        }

                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: modelData.label || ""
                            font.pixelSize: 10
                            color: "#A6ADC8"
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            width: tile.width - 8
                        }
                    }
                }

                MouseArea {
                    id: dragArea
                    anchors.fill: parent
                    hoverEnabled: true
                    drag.target: tile

                    onClicked: {
                        if (typeof bridge !== 'undefined') {
                            bridge.send({ type: 'component_pick', componentType: modelData.type })
                        }
                    }

                    onReleased: {
                        if (tile.Drag.active) {
                            tile.Drag.drop()
                        }
                        // Reset position so tile snaps back to grid
                        tile.x = 0
                        tile.y = 0
                    }
                }
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'palette_update') {
                root.components = payload.components || root.components
            }
        }
    }
}
