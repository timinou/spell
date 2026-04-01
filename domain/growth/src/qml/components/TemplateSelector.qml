import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// Displays a scrollable list of Typst templates.
// Emits template_selected via bridge when the user picks one.
Item {
    id: templateSelector

    // Populated by the host via bridge message { type: 'templates_list', templates: [...] }
    // Each entry: { id: string, name: string, description: string, path: string }
    property var templates: []

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 8
        spacing: 8

        Text {
            text: "Templates"
            font.pixelSize: 13
            font.weight: Font.SemiBold
            color: "#CDD6F4"
        }

        ListView {
            id: listView
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 4
            clip: true
            model: templateSelector.templates

            delegate: ItemDelegate {
                id: delegateRoot
                width: listView.width
                height: contentCol.implicitHeight + 16

                background: Rectangle {
                    radius: 6
                    color: delegateRoot.hovered ? "#313244" : "#1E1E2E"
                    border.color: "#45475A"
                    border.width: 1
                }

                contentItem: ColumnLayout {
                    id: contentCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: 8
                    spacing: 2

                    Text {
                        Layout.fillWidth: true
                        text: modelData.name || ""
                        font.pixelSize: 12
                        font.weight: Font.Medium
                        color: "#CDD6F4"
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: modelData.description || ""
                        font.pixelSize: 11
                        color: "#A6ADC8"
                        elide: Text.ElideRight
                        visible: (modelData.description || "") !== ""
                    }
                }

                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({
                            type: 'template_selected',
                            templateId: modelData.id || "",
                            templatePath: modelData.path || ""
                        })
                    }
                }
            }

            // Empty state
            Text {
                anchors.centerIn: parent
                visible: listView.count === 0
                text: "No templates available"
                font.pixelSize: 12
                color: "#6C7086"
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'templates_list') {
                templateSelector.templates = payload.templates || []
            }
        }
    }
}
