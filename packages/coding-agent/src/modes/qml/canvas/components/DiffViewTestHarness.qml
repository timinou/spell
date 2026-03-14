import QtQuick 2.15
import QtQuick.Controls 2.15
import "../.." as SpellUI

ApplicationWindow {
    visible: true
    width: windowWidth || 900
    height: windowHeight || 600
    title: "DiffView Test"
    color: SpellUI.SpellTheme.background

    property var lastLineClick: null
    property var lastHunkApprove: null

    DiffView {
        id: diffView
        anchors.fill: parent
        anchors.margins: 8
        diffData: currentDiffData
        onLineClicked: function(idx, type, text) { lastLineClick = {lineIndex: idx, type: type, text: text} }
        onHunkApproved: function(idx) { lastHunkApprove = idx }
    }

    property var currentDiffData: null

    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.type === "query") {
                handleQuery(payload)
            } else if (payload.type === "reset") {
                currentDiffData = null
                lastLineClick = null
                lastHunkApprove = null
                bridge.send({ type: "reset_done" })
            } else if (payload.type === "set_diff") {
                currentDiffData = payload.data
                bridge.send({ type: "diff_set_done" })
            } else if (payload.type === "emit_click") {
                diffView.lineClicked(payload.lineIndex, payload.lineType, payload.text)
            }
        }
    }

    function handleQuery(payload) {
        var queryName = payload.query
        var result = null
        if (queryName === "lineCount") {
            result = diffView.flatLines.length
        } else if (queryName === "lastLineClick") {
            result = lastLineClick
        } else if (queryName === "lastHunkApprove") {
            result = lastHunkApprove
        }
        bridge.send({ type: "query_response", query: queryName, result: result })
    }
}
