import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Left-edge drawer that lists active remote panels.
// PanelManager emits panelLoaded/panelClosed; Main.qml is expected to
// wire those signals into activePanels model.
Drawer {
    id: root

    // Model shape: { id: string, title: string }
    ListModel { id: activePanels }

    // Called by Main when a panel becomes available/unavailable.
    function addPanel(id, title) {
        // Avoid duplicates
        for (let i = 0; i < activePanels.count; i++) {
            if (activePanels.get(i).id === id) {
                activePanels.set(i, { id: id, title: title })
                return
            }
        }
        activePanels.append({ id: id, title: title })
    }

    function removePanel(id) {
        for (let i = 0; i < activePanels.count; i++) {
            if (activePanels.get(i).id === id) {
                activePanels.remove(i)
                return
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Drawer header
        Pane {
            Layout.fillWidth: true
            padding: 16
            background: Rectangle { color: "#6750A4" }

            Label {
                text: "Active Panels"
                color: "#FFFFFF"
                font.bold: true
                font.pixelSize: 16
            }
        }

        // Panel list
        ListView {
            id: panelList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: activePanels

            delegate: ItemDelegate {
                width: ListView.view.width
                contentItem: RowLayout {
                    spacing: 8
                    Rectangle {
                        width: 8; height: 8; radius: 4
                        color: "#4CAF50"
                        anchors.verticalCenter: parent.verticalCenter
                    }
                    Column {
                        Layout.fillWidth: true
                        Label {
                            text: model.title || model.id
                            font.bold: true
                            font.pixelSize: 14
                            elide: Label.ElideRight
                            width: parent.width
                        }
                        Label {
                            text: model.id
                            font.pixelSize: 11
                            color: "#757575"
                            elide: Label.ElideRight
                            width: parent.width
                        }
                    }
                }
                onClicked: {
                    // Panels run in their own QQmlApplicationEngine windows.
                    // Tapping brings focus; on Android the panel window overlays.
                    root.close()
                }
            }
        }

        // Empty state
        Item {
            visible: activePanels.count === 0
            Layout.fillWidth: true
            Layout.fillHeight: true

            Label {
                anchors.centerIn: parent
                text: "No active panels"
                color: "#9E9E9E"
                font.pixelSize: 14
            }
        }
    }
}
