import QtQuick 2.15
import "../.." as SpellUI

Item {
    id: root
    required property string msgId
    required property string role
    required property string text
    required property string thinking
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int index
    required property bool isError

    signal toggleExpanded(int index)

    width: ListView.view ? ListView.view.width - ListView.view.leftMargin - ListView.view.rightMargin : 0
    height: delegateLoader.item ? delegateLoader.item.height : 0

    Loader {
        id: delegateLoader
        width: parent.width
        Component.onCompleted: {
            var url = root.role === "user" ? "UserBubble.qml"
                    : root.role === "tool" ? "ToolCard.qml"
                    : root.role === "image" ? "ImageBubble.qml"
                    : "AssistantBubble.qml"
            var props = {
                text: Qt.binding(function() { return root.text }),
                name: Qt.binding(function() { return root.name }),
                isStreaming: Qt.binding(function() { return root.isStreaming }),
                isExpanded: Qt.binding(function() { return root.isExpanded }),
                isError: Qt.binding(function() { return root.isError }),
                messageIndex: root.index
            }
            if (root.role === "assistant")
                props.thinking = Qt.binding(function() { return root.thinking })
            setSource(Qt.resolvedUrl(url), props)
        }

        // Forward toggleExpanded from ToolCard
        Connections {
            target: delegateLoader.item
            ignoreUnknownSignals: true
            function onToggleExpanded(index) {
                root.toggleExpanded(index)
            }
        }
    }
}
