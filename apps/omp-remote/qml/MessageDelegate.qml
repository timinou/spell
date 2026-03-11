import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Roles expected in the model:
//   role        : "user" | "assistant" | "tool"
//   text        : string
//   isStreaming : bool
//   toolName    : string  (role === "tool")
//   toolStatus  : string  ("pending" | "done")
//   toolArgs    : string  (JSON string of tool arguments)
Item {
    id: root

    // Width is inherited from ListView; height is driven by content.
    width: ListView.view ? ListView.view.width : 400
    height: loader.height + 12

    Loader {
        id: loader
        width: parent.width
        anchors.top: parent.top
        anchors.topMargin: 6

        sourceComponent: {
            if (model.role === "tool") return toolCard
            if (model.role === "user") return userBubble
            return assistantBubble
        }
    }

    // ── User bubble (right-aligned) ───────────────────────────────────
    Component {
        id: userBubble
        Item {
            width: parent ? parent.width : 400
            height: bubble.height

            Rectangle {
                id: bubble
                anchors.right: parent.right
                anchors.rightMargin: 12
                width: Math.min(label.implicitWidth + 24, parent.width * 0.75)
                height: label.implicitHeight + 16
                radius: 12
                color: "#6750A4" // Material 3 primary

                Text {
                    id: label
                    anchors.centerIn: parent
                    width: parent.width - 24
                    text: model.text
                    wrapMode: Text.Wrap
                    color: "#FFFFFF"
                    font.pixelSize: 15
                }
            }
        }
    }

    // ── Assistant bubble (left-aligned) ──────────────────────────────
    Component {
        id: assistantBubble
        Item {
            width: parent ? parent.width : 400
            height: bubble.height

            Rectangle {
                id: bubble
                anchors.left: parent.left
                anchors.leftMargin: 12
                width: Math.min(label.implicitWidth + 24, parent.width * 0.85)
                height: label.implicitHeight + 16
                radius: 12
                color: "#E8DEF8" // Material 3 surface variant

                Text {
                    id: label
                    anchors.centerIn: parent
                    width: parent.width - 24
                    text: model.text + (model.isStreaming ? "▋" : "")
                    wrapMode: Text.Wrap
                    color: "#1C1B1F"
                    font.pixelSize: 15
                }
            }
        }
    }

    // ── Tool call card ────────────────────────────────────────────────
    Component {
        id: toolCard
        ToolCallCard {
            toolName: model.toolName
            toolStatus: model.toolStatus
            toolArgs: model.toolArgs
        }
    }
}
