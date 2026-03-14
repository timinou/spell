import QtQuick 2.15
import QtQuick.Controls 2.15
import ".." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 600
    title: windowTitle || "Canvas Test"
    color: SpellUI.SpellTheme.background

    AgentCanvas {
        id: canvas
        anchors.fill: parent
    }

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === "query") {
                handleQuery(payload)
            } else if (payload.type === "reset") {
                handleReset()
            } else {
                canvas.handleMessage(payload)
            }
        }
    }

    onClosing: function(close) {
        bridge.send({ action: "close" })
    }

    function handleQuery(payload) {
        var queryName = payload.query
        var result = null

        if (queryName === "blockCount") {
            result = canvas.blocksModel.length
        } else if (queryName === "blocks") {
            result = canvas.blocksModel
        } else if (queryName === "promptCount") {
            result = canvas.promptsModel.length
        } else if (queryName.indexOf("blockById?") === 0) {
            var bid = queryName.substring("blockById?".length)
            for (var i = 0; i < canvas.blocksModel.length; i++) {
                if (canvas.blocksModel[i].id === bid) {
                    result = canvas.blocksModel[i]
                    break
                }
            }
        } else if (queryName.indexOf("promptById?") === 0) {
            var pid = queryName.substring("promptById?".length)
            for (var j = 0; j < canvas.promptsModel.length; j++) {
                if (canvas.promptsModel[j].promptId === pid) {
                    result = canvas.promptsModel[j]
                    break
                }
            }
        }

        bridge.send({
            type: "query_response",
            query: queryName,
            result: result
        })
    }

    function handleReset() {
        canvas.blocksModel = []
        canvas.promptsModel = []
        bridge.send({ type: "reset_done" })
    }
}
