import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: root
    visible: true
    width: 400
    height: 800
    title: "omp remote"

    // Determine server URL: first command-line arg, else default.
    readonly property string defaultServerUrl: "ws://localhost:9473"

    Component.onCompleted: {
        const args = Qt.application.arguments
        // argv[0] is the binary; use argv[1] if present and starts with "ws"
        let url = defaultServerUrl
        if (args.length > 1 && args[1].startsWith("ws")) {
            url = args[1]
        }
        remoteClient.connectToServer(url)
    }

    // Left drawer listing active panels
    PanelDrawer {
        id: panelDrawer
        width: Math.min(root.width * 0.75, 300)
        height: root.height
        edge: Qt.LeftEdge
    }

    // Toolbar with hamburger to open drawer
    header: ToolBar {
        RowLayout {
            anchors.fill: parent
            ToolButton {
                text: "\u2630"
                font.pixelSize: 20
                onClicked: panelDrawer.open()
            }
            Label {
                text: "omp remote"
                elide: Label.ElideRight
                Layout.fillWidth: true
            }
            // Connection indicator
            Rectangle {
                width: 10; height: 10; radius: 5
                color: remoteClient.connected ? "#4caf50" : "#f44336"
                anchors.verticalCenter: parent.verticalCenter
            }
            Item { width: 8 }
        }
    }

    // Main content: StackView so panels can push on top of ChatView
    StackView {
        id: stackView
        anchors.fill: parent
        initialItem: chatView
    }

    ChatView {
        id: chatView
        visible: false // managed by StackView
    }

    Connections {
        target: remoteClient
        function onError(message) {
            console.warn("RemoteClient error:", message)
        }
    }

    // Keep PanelDrawer in sync with PanelManager lifecycle signals.
    // panelManager is not a context property — we react via RemoteClient
    // panel commands that echo through panelCommandReceived.
    // Instead, expose a small JS bridge on the drawer itself and wire
    // from panelCommandReceived so we don't need a second context property.
    Connections {
        target: remoteClient
        function onPanelCommandReceived(data) {
            const type = data["type"] ? data["type"].toString() : ""
            const id   = data["id"]   ? data["id"].toString()   : ""
            const title = data["title"] ? data["title"].toString() : id
            if (type === "push_qml") {
                panelDrawer.addPanel(id, title)
            } else if (type === "close_panel") {
                panelDrawer.removePanel(id)
            }
        }
    }
}
