import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root

    // Backing model for the message list
    ListModel { id: messages }

    // Accumulates streaming assistant text into the last message
    property string streamingBuffer: ""

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // ── Message list ──────────────────────────────────────────────
        ListView {
            id: messageList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 6
            verticalLayoutDirection: ListView.TopToBottom
            // Always scroll to the newest message
            onCountChanged: Qt.callLater(() => messageList.positionViewAtEnd())

            model: messages
            delegate: MessageDelegate {}
        }

        // ── Input bar ─────────────────────────────────────────────────
        Pane {
            Layout.fillWidth: true
            padding: 8

            RowLayout {
                anchors.fill: parent
                spacing: 6

                TextArea {
                    id: inputField
                    Layout.fillWidth: true
                    placeholderText: "Message…"
                    wrapMode: TextArea.Wrap
                    // Send on Enter (Shift+Enter inserts newline)
                    Keys.onReturnPressed: (event) => {
                        if (event.modifiers & Qt.ShiftModifier) {
                            event.accepted = false
                        } else {
                            sendButton.clicked()
                            event.accepted = true
                        }
                    }
                }

                Button {
                    id: sendButton
                    text: "Send"
                    enabled: inputField.text.trim().length > 0
                    onClicked: {
                        const text = inputField.text.trim()
                        if (!text) return
                        // Append user message to the list immediately
                        messages.append({
                            role: "user",
                            text: text,
                            isStreaming: false,
                            toolName: "",
                            toolStatus: "",
                            toolArgs: ""
                        })
                        remoteClient.sendRpcCommand({ "type": "prompt", "message": text })
                        inputField.text = ""
                    }
                }
            }
        }
    }

    // ── Handle RPC events from server ─────────────────────────────────
    Connections {
        target: remoteClient

        function onRpcEventReceived(event) {
            const type = event["type"] ? event["type"].toString() : ""

            if (type === "delta") {
                // Streaming token: append to last assistant message or create one
                const delta = event["delta"] ? event["delta"].toString() : ""
                if (messages.count > 0) {
                    const last = messages.get(messages.count - 1)
                    if (last.role === "assistant" && last.isStreaming) {
                        messages.set(messages.count - 1, {
                            role: "assistant",
                            text: last.text + delta,
                            isStreaming: true,
                            toolName: "",
                            toolStatus: "",
                            toolArgs: ""
                        })
                        return
                    }
                }
                messages.append({
                    role: "assistant",
                    text: delta,
                    isStreaming: true,
                    toolName: "",
                    toolStatus: "",
                    toolArgs: ""
                })

            } else if (type === "complete") {
                // Mark the last streaming message as done
                if (messages.count > 0) {
                    const last = messages.get(messages.count - 1)
                    if (last.role === "assistant" && last.isStreaming) {
                        messages.set(messages.count - 1, {
                            role: last.role,
                            text: last.text,
                            isStreaming: false,
                            toolName: last.toolName,
                            toolStatus: last.toolStatus,
                            toolArgs: last.toolArgs
                        })
                    }
                }

            } else if (type === "tool_call_start") {
                const name = event["name"] ? event["name"].toString() : "tool"
                const args = event["args"] ? JSON.stringify(event["args"]) : ""
                messages.append({
                    role: "tool",
                    text: "",
                    isStreaming: true,
                    toolName: name,
                    toolStatus: "pending",
                    toolArgs: args
                })

            } else if (type === "tool_call_result") {
                // Find the last pending tool call and mark it done
                for (let i = messages.count - 1; i >= 0; i--) {
                    const msg = messages.get(i)
                    if (msg.role === "tool" && msg.toolStatus === "pending") {
                        messages.set(i, {
                            role: "tool",
                            text: event["result"] ? event["result"].toString() : "",
                            isStreaming: false,
                            toolName: msg.toolName,
                            toolStatus: "done",
                            toolArgs: msg.toolArgs
                        })
                        break
                    }
                }

            } else if (type === "state_change") {
                // Could display state in a status bar; currently no-op.
            }
        }
    }
}
