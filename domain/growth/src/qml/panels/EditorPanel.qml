import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../components"

Item {
    id: editorPanel

    // Current file path shown in the header bar
    property string currentPath: ""

    // Whether the file tree sidebar is expanded
    property bool fileTreeVisible: false

    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal

        // ── Left: Editor pane ───────────────────────────────────────────────
        Item {
            SplitView.preferredWidth: parent.width * 0.5
            SplitView.minimumWidth: 300

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                // Toolbar: file path + toggle for file tree
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 36
                    color: "#181825"
                    border.color: "#313244"
                    border.width: 0

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 8
                        anchors.rightMargin: 8
                        spacing: 8

                        // Toggle file tree
                        ToolButton {
                            text: "☰"
                            font.pixelSize: 14
                            implicitWidth: 28
                            implicitHeight: 28
                            onClicked: editorPanel.fileTreeVisible = !editorPanel.fileTreeVisible
                        }

                        Text {
                            Layout.fillWidth: true
                            text: editorPanel.currentPath !== "" ? editorPanel.currentPath : "untitled.typ"
                            font.pixelSize: 11
                            color: "#A6ADC8"
                            elide: Text.ElideLeft
                        }

                        // Open template drawer
                        ToolButton {
                            text: "⊞"
                            font.pixelSize: 14
                            implicitWidth: 28
                            implicitHeight: 28
                            onClicked: templateDrawer.open()
                        }
                    }
                }

                // Collapsible file tree
                TypstFileTree {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 150
                    visible: editorPanel.fileTreeVisible
                }

                // Monaco editor placeholder
                // Replace with WebEngineView + typst-editor.html when QtWebEngine is available.
                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    color: "#1e1e1e"

                    Text {
                        anchors.centerIn: parent
                        text: "Typst Editor (WebEngineView)"
                        color: "#808080"
                        font.pixelSize: 13
                    }
                }
            }
        }

        // ── Right: Preview pane ─────────────────────────────────────────────
        Item {
            SplitView.preferredWidth: parent.width * 0.5
            SplitView.minimumWidth: 300

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                // Preview toolbar
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 36
                    color: "#181825"
                    border.color: "#313244"
                    border.width: 0

                    Text {
                        anchors.centerIn: parent
                        text: "Preview"
                        font.pixelSize: 11
                        color: "#A6ADC8"
                    }
                }

                // SVG preview area
                // Replace inner content with an Image { source: svgDataUrl } once
                // compile_result messages carry the rendered SVG.
                Rectangle {
                    id: previewRect
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    color: "white"

                    // Placeholder — replaced by dynamic SVG content at runtime
                    Text {
                        id: previewPlaceholder
                        anchors.centerIn: parent
                        text: "Typst Preview (SVG)"
                        color: "#808080"
                        font.pixelSize: 13
                        visible: svgContent.text === ""
                    }

                    // SVG rendered as an image via data: URL
                    Image {
                        id: svgContent
                        anchors.fill: parent
                        fillMode: Image.PreserveAspectFit
                        visible: source.toString() !== ""
                        // source is set programmatically: "data:image/svg+xml," + encodeURIComponent(svg)
                        property string text: ""
                    }

                    // Error overlay
                    Rectangle {
                        id: errorOverlay
                        anchors.bottom: parent.bottom
                        anchors.left: parent.left
                        anchors.right: parent.right
                        height: errorCol.implicitHeight + 12
                        color: "#3a1e1e"
                        visible: errorCol.count > 0

                        ColumnLayout {
                            id: errorCol
                            anchors.fill: parent
                            anchors.margins: 6
                            spacing: 2

                            property int count: 0

                            Repeater {
                                id: errorRepeater
                                model: []
                                onCountChanged: errorCol.count = count

                                delegate: Text {
                                    Layout.fillWidth: true
                                    text: (modelData.line !== undefined ? "L" + modelData.line + ": " : "") + (modelData.message || "")
                                    font.pixelSize: 11
                                    color: "#F38BA8"
                                    elide: Text.ElideRight
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Template selector drawer (left edge) ────────────────────────────────
    Drawer {
        id: templateDrawer
        width: 280
        height: parent.height
        edge: Qt.LeftEdge
        // Slightly transparent so you can see the editor behind it
        background: Rectangle { color: "#1E1E2E" }

        TemplateSelector {
            anchors.fill: parent
        }
    }

    // ── Bridge message handling ──────────────────────────────────────────────
    Connections {
        target: typeof bridge !== 'undefined' ? bridge : null

        function onMessageReceived(payload) {
            if (payload.type === 'set_content') {
                editorPanel.currentPath = payload.path || editorPanel.currentPath
                // TODO: push payload.text into the WebEngineView editor once wired
            }

            if (payload.type === 'compile_result') {
                // Render SVG
                if (payload.svg && payload.svg !== "") {
                    svgContent.source = "data:image/svg+xml," + encodeURIComponent(payload.svg)
                    svgContent.text = payload.svg
                }
                // Surface errors
                errorRepeater.model = payload.errors || []
            }

            if (payload.type === 'file_list') {
                // Forward to TypstFileTree via its own Connections handler
            }
        }
    }

    Component.onCompleted: {
        if (typeof bridge !== 'undefined') {
            bridge.send({ type: 'panel_ready', panelId: 'editor' })
        }
    }
}
