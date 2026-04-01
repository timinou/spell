import QtQuick 2.15

// Minimal panel stub for testing message forwarding.
// Exposes handleMessage and tracks received messages for assertion.
Item {
    property int messageCount: 0
    property var lastMessage: null
    property string lastMessageType: ""

    function handleMessage(msg) {
        messageCount++
        lastMessage = msg
        lastMessageType = msg && msg.type ? msg.type : ""
    }
}
