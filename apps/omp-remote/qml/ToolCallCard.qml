import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Displays a single tool-call with collapsible args and approve/reject actions.
// Properties are set by MessageDelegate from ListModel roles.
Rectangle {
    id: root

    property string toolName: ""
    property string toolStatus: "pending"  // "pending" | "done"
    property string toolArgs: ""           // JSON string

    property bool expanded: false

    width: parent ? parent.width - 24 : 360
    anchors.horizontalCenter: parent ? parent.horizontalCenter : undefined
    height: content.height + 16
    radius: 8
    color: "#FFF8E1"
    border.color: toolStatus === "pending" ? "#FF9800" : "#4CAF50"
    border.width: 1

    ColumnLayout {
        id: content
        anchors {
            left: parent.left; right: parent.right; top: parent.top
            margins: 8
        }
        spacing: 6

        // ── Header row ────────────────────────────────────────────────
        RowLayout {
            Layout.fillWidth: true

            // Status dot
            Rectangle {
                width: 8; height: 8; radius: 4
                color: root.toolStatus === "pending" ? "#FF9800" : "#4CAF50"
            }

            Label {
                text: root.toolName || "tool call"
                font.bold: true
                font.pixelSize: 14
                Layout.fillWidth: true
            }

            ToolButton {
                text: root.expanded ? "▲" : "▼"
                onClicked: root.expanded = !root.expanded
                padding: 2
            }
        }

        // ── Arguments (collapsible) ────────────────────────────────────
        TextArea {
            visible: root.expanded && root.toolArgs.length > 0
            Layout.fillWidth: true
            readOnly: true
            text: root.toolArgs
            font.family: "monospace"
            font.pixelSize: 12
            color: "#333"
            background: Rectangle { color: "#F5F5F5"; radius: 4 }
            wrapMode: TextArea.Wrap
        }

        // ── Approve / Reject buttons (pending only) ────────────────────
        RowLayout {
            visible: root.toolStatus === "pending"
            Layout.fillWidth: true
            spacing: 8

            Button {
                text: "Approve"
                Layout.fillWidth: true
                onClicked: remoteClient.sendRpcCommand({ "type": "steer", "message": "proceed" })
            }

            Button {
                text: "Reject"
                Layout.fillWidth: true
                onClicked: remoteClient.sendRpcCommand({ "type": "abort" })
            }
        }
    }
}
