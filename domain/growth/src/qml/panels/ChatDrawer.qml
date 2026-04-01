import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: chatDrawer

    property bool expanded: false
    property int collapsedHeight: 56
    property int expandedHeight: 400
    property var agentTabs: []
    property int activeTabIndex: 0

    // Clamp: never exceed expandedHeight; never go below collapsedHeight.
    height: expanded ? expandedHeight : collapsedHeight
    color: "#1F2937"

    Behavior on height { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Drag handle bar — click to toggle expand/collapse
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 32
            color: "#374151"

            Rectangle {
                anchors.centerIn: parent
                width: 40; height: 4; radius: 2
                color: "#6B7280"
            }

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: chatDrawer.expanded = !chatDrawer.expanded
            }
        }

        // Tab bar (visible when expanded)
        TabBar {
            id: tabBar
            Layout.fillWidth: true
            visible: expanded
            background: Rectangle { color: "#1F2937" }

            Repeater {
                model: agentTabs
                TabButton {
                    text: modelData.name
                    width: implicitWidth
                    onClicked: activeTabIndex = index
                }
            }
        }

        // Chat content (visible when expanded)
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: expanded
            color: "#111827"

            Text {
                anchors.centerIn: parent
                text: agentTabs.length > 0
                    ? "Chat with " + (agentTabs[activeTabIndex] ? agentTabs[activeTabIndex].name : "Agent")
                    : "No active agents"
                color: "#9CA3AF"
            }
        }

        // Input bar (visible when expanded)
        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 48
            Layout.margins: 8
            visible: expanded
            spacing: 8

            TextField {
                id: chatInput
                Layout.fillWidth: true
                placeholderText: "Type a message..."
                color: "#F9FAFB"
                background: Rectangle { color: "#374151"; radius: 8 }
                onAccepted: {
                    var trimmed = text.trim()
                    if (trimmed) {
                        var agentId = agentTabs.length > 0 && agentTabs[activeTabIndex]
                            ? agentTabs[activeTabIndex].id
                            : undefined
                        bridge.send({ type: 'chat_message', text: trimmed, agentId: agentId })
                        text = ""
                    }
                }
            }

            Button {
                text: "Send"
                onClicked: chatInput.accepted()
            }
        }

        // Collapsed preview (visible when collapsed)
        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 24
            Layout.margins: 8
            visible: !expanded

            Label {
                text: agentTabs.length > 0 && agentTabs[activeTabIndex]
                    ? agentTabs[activeTabIndex].name + ": " + (agentTabs[activeTabIndex].latestMessage || "Idle")
                    : "Chat"
                color: "#9CA3AF"
                font.pixelSize: 12
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
        }
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === 'agent_tabs_update') {
                agentTabs = payload.tabs
                // Guard active index against out-of-range after tab count changes.
                if (activeTabIndex >= agentTabs.length) {
                    activeTabIndex = agentTabs.length > 0 ? agentTabs.length - 1 : 0
                }
            }
        }
    }
}
