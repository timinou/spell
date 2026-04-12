import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// Flat list of .typ files presented as a tree-style sidebar.
// Emits file_selected via bridge when the user picks a file.
//
// Note: Qt 6.3+ has a native TreeView; for earlier Qt 6 we use a flat ListView
// grouped by directory prefix, which covers the common single-workspace case
// without a recursive model dependency.
Item {
    id: fileTree

    // Populated by bridge message { type: 'file_list', files: [...] }
    // Each entry: { path: string, name: string, dir: string }
    property var files: []

    // Currently selected file path (highlighted in the list)
    property string selectedPath: ""
    signal fileSelected(string filePath)

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 4
        spacing: 4

        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: "Files"
                font.pixelSize: 11
                font.weight: Font.DemiBold
                color: "#A6ADC8"
            }

            Item { Layout.fillWidth: true }

            // Refresh button — asks backend to rescan
            ToolButton {
                text: "⟳"
                font.pixelSize: 13
                implicitWidth: 24
                implicitHeight: 24
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'refresh_file_list' })
                    }
                }
            }
        }

        ListView {
            id: fileListView
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 1
            clip: true
            model: fileTree.files

            delegate: ItemDelegate {
                id: fileDelegate
                width: fileListView.width
                height: 28

                readonly property bool isSelected: modelData.path === fileTree.selectedPath

                background: Rectangle {
                    color: {
                        if (fileDelegate.isSelected) return "#45475A"
                        if (fileDelegate.hovered)    return "#313244"
                        return "transparent"
                    }
                    radius: 4
                }

                contentItem: RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 8
                    spacing: 6

                    // File icon
                    Text {
                        text: "📄"
                        font.pixelSize: 11
                    }

                    Text {
                        Layout.fillWidth: true
                        text: modelData.name || modelData.path || ""
                        font.pixelSize: 11
                        color: fileDelegate.isSelected ? "#CDD6F4" : "#A6ADC8"
                        elide: Text.ElideMiddle

                        ToolTip.visible: hovered
                        ToolTip.text: modelData.path || ""
                        ToolTip.delay: 600
                    }
                }

                onClicked: {
                    fileTree.selectedPath = modelData.path || ""
                    fileTree.fileSelected(modelData.path || "")
                    if (typeof bridge !== 'undefined') {
                        bridge.send({
                            type: 'file_selected',
                            filePath: modelData.path || ""
                        })
                    }
                }
            }

            // Empty state
            Text {
                anchors.centerIn: parent
                visible: fileListView.count === 0
                text: "No .typ files found"
                font.pixelSize: 11
                color: "#6C7086"
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'file_list') {
                fileTree.files = payload.files || []
            }
            // When backend opens a file, mirror the selection highlight
            if (payload.type === 'set_content') {
                fileTree.selectedPath = payload.path || fileTree.selectedPath
            }
        }
    }
}
