import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Item {
    id: chatPanel

    property bool isStreaming: false
    property int tokenCount: 0
    property string modelName: ""

    ListModel {
        id: messagesModel
    }

    function handleMessage(msg) {
        if (!msg || !msg.type) return

        if (msg.type === "message_start") {
            messagesModel.append({
                msgId: msg.id || "",
                role: "assistant",
                text: "",
                name: "",
                isStreaming: true,
                isExpanded: false
            })
            chatPanel.isStreaming = true
            messageList.positionViewAtEnd()
        } else if (msg.type === "message_update") {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    var current = messagesModel.get(i).text
                    messagesModel.setProperty(i, "text", current + (msg.text || ""))
                    break
                }
            }
            messageList.positionViewAtEnd()
        } else if (msg.type === "message_end") {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    messagesModel.setProperty(i, "isStreaming", false)
                    break
                }
            }
            chatPanel.isStreaming = false
            if (msg.tokens) chatPanel.tokenCount = msg.tokens
        } else if (msg.type === "tool_start") {
            messagesModel.append({
                msgId: msg.id || "",
                role: "tool",
                text: msg.details || "",
                name: msg.name || "tool",
                isStreaming: true,
                isExpanded: false
            })
            messageList.positionViewAtEnd()
        } else if (msg.type === "tool_end") {
            for (var i = messagesModel.count - 1; i >= 0; i--) {
                if (messagesModel.get(i).msgId === msg.id) {
                    messagesModel.setProperty(i, "isStreaming", false)
                    if (msg.details) messagesModel.setProperty(i, "text", msg.details)
                    break
                }
            }
        } else if (msg.type === "agent_busy") {
            chatPanel.isStreaming = !!msg.busy
        } else if (msg.type === "model_info") {
            chatPanel.modelName = msg.model || ""
        }
    }

    function sendMessage() {
        var text = inputField.text.trim()
        if (text.length === 0) return

        messagesModel.append({
            msgId: "user-" + Date.now(),
            role: "user",
            text: text,
            name: "",
            isStreaming: false,
            isExpanded: false
        })
        inputField.text = ""
        messageList.positionViewAtEnd()
        bridge.send({ type: "prompt", text: text })
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Message list
        ListView {
            id: messageList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: SpellUI.SpellTheme.spacingS
            leftMargin: SpellUI.SpellTheme.spacingXL
            rightMargin: SpellUI.SpellTheme.spacingXL
            topMargin: SpellUI.SpellTheme.spacingL
            bottomMargin: SpellUI.SpellTheme.spacingL

            model: messagesModel

            delegate: Item {
                width: messageList.width - messageList.leftMargin - messageList.rightMargin
                height: delegateLoader.item ? delegateLoader.item.height : 0

                Loader {
                    id: delegateLoader
                    width: parent.width
                    sourceComponent: {
                        if (model.role === "user") return userDelegate
                        if (model.role === "tool") return toolDelegate
                        return assistantDelegate
                    }
                }
            }

            // Streaming indicator
            footer: Item {
                width: messageList.width - messageList.leftMargin - messageList.rightMargin
                height: chatPanel.isStreaming ? 20 : 0
                visible: chatPanel.isStreaming

                Rectangle {
                    id: streamDot
                    width: 8
                    height: 8
                    radius: 4
                    color: SpellUI.SpellTheme.primary
                    anchors.verticalCenter: parent.verticalCenter

                    SequentialAnimation on opacity {
                        running: chatPanel.isStreaming
                        loops: Animation.Infinite
                        NumberAnimation { from: 1.0; to: 0.3; duration: 600 }
                        NumberAnimation { from: 0.3; to: 1.0; duration: 600 }
                    }
                }
            }
        }

        // Input area
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: Math.max(52, inputField.contentHeight + SpellUI.SpellTheme.spacingL * 2)
            Layout.maximumHeight: 200
            color: SpellUI.SpellTheme.surface
            border.color: SpellUI.SpellTheme.outline
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingS

                // Input field container
                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    radius: SpellUI.SpellTheme.cornerRadius
                    color: SpellUI.SpellTheme.surfaceHigh

                    // Placeholder
                    Text {
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingS
                        text: "Type a message..."
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                        color: SpellUI.SpellTheme.textTertiary
                        verticalAlignment: Text.AlignVCenter
                        visible: inputField.text.length === 0 && !inputField.activeFocus
                    }

                    Flickable {
                        id: inputFlick
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingS
                        contentWidth: inputField.paintedWidth
                        contentHeight: inputField.paintedHeight
                        clip: true

                        function ensureVisible(r) {
                            if (contentX >= r.x) contentX = r.x
                            else if (contentX + width <= r.x + r.width) contentX = r.x + r.width - width
                            if (contentY >= r.y) contentY = r.y
                            else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height
                        }

                        TextEdit {
                            id: inputField
                            width: inputFlick.width
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            color: SpellUI.SpellTheme.textPrimary
                            selectionColor: SpellUI.SpellTheme.primaryContainer
                            wrapMode: TextEdit.Wrap
                            onCursorRectangleChanged: inputFlick.ensureVisible(cursorRectangle)

                            Keys.onPressed: function(event) {
                                if (event.key === Qt.Key_Return && !(event.modifiers & Qt.ShiftModifier)) {
                                    event.accepted = true
                                    chatPanel.sendMessage()
                                }
                            }
                        }
                    }
                }

                // Send button
                Rectangle {
                    Layout.preferredWidth: 36
                    Layout.preferredHeight: 36
                    Layout.alignment: Qt.AlignBottom
                    radius: SpellUI.SpellTheme.cornerRadius
                    color: SpellUI.SpellTheme.primary
                    visible: !chatPanel.isStreaming

                    Text {
                        anchors.centerIn: parent
                        text: "↑"
                        font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                        font.bold: true
                        color: SpellUI.SpellTheme.primaryText
                    }

                    SpellUI.StateLayer {
                        onClicked: chatPanel.sendMessage()
                    }
                }

                // Abort button
                Rectangle {
                    Layout.preferredWidth: 36
                    Layout.preferredHeight: 36
                    Layout.alignment: Qt.AlignBottom
                    radius: SpellUI.SpellTheme.cornerRadius
                    color: SpellUI.SpellTheme.error
                    visible: chatPanel.isStreaming

                    Text {
                        anchors.centerIn: parent
                        text: "■"
                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        color: SpellUI.SpellTheme.primaryText
                    }

                    SpellUI.StateLayer {
                        onClicked: bridge.send({ type: "abort" })
                    }
                }
            }
        }

        // Status bar
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 28
            color: SpellUI.SpellTheme.surface

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: SpellUI.SpellTheme.spacingL
                anchors.rightMargin: SpellUI.SpellTheme.spacingL
                spacing: SpellUI.SpellTheme.spacingL

                Text {
                    text: chatPanel.modelName || "—"
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: chatPanel.tokenCount > 0 ? chatPanel.tokenCount + " tokens" : ""
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                }
            }
        }
    }

    // --- Delegate components ---

    Component {
        id: assistantDelegate

        Rectangle {
            width: parent ? parent.width : 0
            height: assistantText.paintedHeight + SpellUI.SpellTheme.spacingL * 2
            color: SpellUI.SpellTheme.surfaceHigh
            radius: SpellUI.SpellTheme.cornerRadius

            Text {
                id: assistantText
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingL
                text: model.text
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                color: SpellUI.SpellTheme.textPrimary
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
            }
        }
    }

    Component {
        id: userDelegate

        Item {
            width: parent ? parent.width : 0
            height: userBubble.height

            Rectangle {
                id: userBubble
                anchors.right: parent.right
                width: Math.min(userText.implicitWidth + SpellUI.SpellTheme.spacingL * 2, parent.width * 0.75)
                height: userText.paintedHeight + SpellUI.SpellTheme.spacingL * 2
                color: SpellUI.SpellTheme.primaryContainer
                radius: SpellUI.SpellTheme.cornerRadius

                Text {
                    id: userText
                    anchors.fill: parent
                    anchors.margins: SpellUI.SpellTheme.spacingL
                    text: model.text
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                    color: SpellUI.SpellTheme.textPrimary
                    wrapMode: Text.Wrap
                    textFormat: Text.PlainText
                }
            }
        }
    }

    Component {
        id: toolDelegate

        Rectangle {
            width: parent ? parent.width : 0
            height: toolColumn.height + SpellUI.SpellTheme.spacingM * 2
            color: SpellUI.SpellTheme.surfaceHigher
            radius: SpellUI.SpellTheme.cornerRadius

            ColumnLayout {
                id: toolColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                // Tool header
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 28
                    color: "transparent"

                    Row {
                        anchors.fill: parent
                        spacing: SpellUI.SpellTheme.spacingS

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "⚙"
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: model.name
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        Item { width: 1; height: 1; Layout.fillWidth: true }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: model.isStreaming ? "⟳" : "✓"
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: model.isStreaming ? SpellUI.SpellTheme.warning : SpellUI.SpellTheme.success
                        }
                    }

                    SpellUI.StateLayer {
                        onClicked: {
                            var idx = model.index
                            messagesModel.setProperty(idx, "isExpanded", !messagesModel.get(idx).isExpanded)
                        }
                    }
                }

                // Tool details (collapsible)
                Text {
                    Layout.fillWidth: true
                    visible: model.isExpanded && model.text.length > 0
                    text: model.text
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textSecondary
                    wrapMode: Text.Wrap
                    textFormat: Text.PlainText
                }
            }
        }
    }
}
