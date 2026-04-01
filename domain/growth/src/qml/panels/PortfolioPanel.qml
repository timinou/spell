import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

Item {
    id: portfolioPanel

    property var clients: []
    property string searchText: ""

    // Filtered view: apply search client-side
    property var filteredClients: {
        if (!portfolioPanel.searchText) return portfolioPanel.clients
        const q = portfolioPanel.searchText.toLowerCase()
        return portfolioPanel.clients.filter(c =>
            (c.clientName || "").toLowerCase().indexOf(q) !== -1
        )
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 14

        // Search bar
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            TextField {
                id: searchField
                Layout.fillWidth: true
                placeholderText: "Search clients…"
                font.pixelSize: 13
                color: "#CDD6F4"
                placeholderTextColor: "#6C7086"
                background: Rectangle {
                    color: "#1E1E2E"
                    border.color: searchField.activeFocus ? "#89B4FA" : "#313244"
                    border.width: 1
                    radius: 6
                }
                onTextChanged: portfolioPanel.searchText = text
            }

            Button {
                text: "Add Client"
                onClicked: {
                    if (typeof bridge !== 'undefined') {
                        bridge.send({ type: 'quick_action', action: 'add_client' })
                    }
                }
            }
        }

        // Client grid
        GridView {
            id: clientGrid
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            cellWidth:  220
            cellHeight: 130

            model: portfolioPanel.filteredClients

            delegate: ClientCard {
                width:  clientGrid.cellWidth  - 10
                height: clientGrid.cellHeight - 10

                clientId:        modelData.clientId        || ""
                clientName:      modelData.clientName      || ""
                campaignCount:   modelData.campaignCount   || 0
                deliverableCount: modelData.deliverableCount || 0
                lastActivity:    modelData.lastActivity    || ""
            }

            // Empty state
            Text {
                anchors.centerIn: parent
                visible: clientGrid.count === 0
                text: portfolioPanel.searchText
                      ? "No clients match \"" + portfolioPanel.searchText + "\""
                      : "No clients yet"
                font.pixelSize: 13
                color: "#6C7086"
            }
        }
    }

    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null
        function onMessageReceived(payload) {
            if (payload.type === 'clients_data') {
                portfolioPanel.clients = payload.clients || []
            }
        }
    }

    Component.onCompleted: {
        if (typeof bridge !== 'undefined') {
            bridge.send({ type: 'panel_ready', panelId: 'portfolio' })
        }
    }
}
