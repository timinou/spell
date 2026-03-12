import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "." as SpellUI

ApplicationWindow {
    id: root
    visible: true
    width: 1280
    height: 800
    title: "Spell"
    color: SpellUI.SpellTheme.background

    property int activePanelIndex: 0
    property var panels: bridge.props.panels || [{ title: "Chat", path: Qt.resolvedUrl("panels/ChatPanel.qml") }]

    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal

        // Left sidebar
        Rectangle {
            SplitView.preferredWidth: 240
            SplitView.minimumWidth: 240
            SplitView.maximumWidth: 240
            color: SpellUI.SpellTheme.surfaceHigh

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                // Header
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 56
                    color: "transparent"

                    Text {
                        anchors.centerIn: parent
                        text: "Spell"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
                        font.bold: true
                        color: SpellUI.SpellTheme.onSurface
                    }
                }

                // Panel list
                ListView {
                    id: panelList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    model: root.panels
                    clip: true

                    delegate: Rectangle {
                        width: panelList.width
                        height: 44
                        color: index === root.activePanelIndex
                            ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, SpellUI.SpellTheme.hoverOpacity)
                            : "transparent"
                        radius: SpellUI.SpellTheme.cornerRadiusSmall

                        Row {
                            anchors.fill: parent
                            anchors.leftMargin: SpellUI.SpellTheme.spacingL
                            anchors.rightMargin: SpellUI.SpellTheme.spacingL
                            spacing: SpellUI.SpellTheme.spacingM

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.icon || "●"
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                color: index === root.activePanelIndex
                                    ? SpellUI.SpellTheme.primary
                                    : SpellUI.SpellTheme.onSurfaceDim
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.title || "Panel"
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                                color: index === root.activePanelIndex
                                    ? SpellUI.SpellTheme.onSurface
                                    : SpellUI.SpellTheme.onSurfaceDim
                            }
                        }

                        SpellUI.StateLayer {
                            onClicked: root.activePanelIndex = index
                        }
                    }
                }

                // Footer
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 80
                    color: "transparent"

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: SpellUI.SpellTheme.spacingM
                        spacing: SpellUI.SpellTheme.spacingS

                        Text {
                            Layout.fillWidth: true
                            text: bridge.props.model || "No model"
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                            color: SpellUI.SpellTheme.onSurfaceDim
                            elide: Text.ElideRight
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 32
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            color: SpellUI.SpellTheme.surfaceHigher

                            Text {
                                anchors.centerIn: parent
                                text: "Restart Agent"
                                font.family: SpellUI.SpellTheme.fontFamily
                                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                                color: SpellUI.SpellTheme.onSurfaceDim
                            }

                            SpellUI.StateLayer {
                                onClicked: bridge.send({ type: "restart" })
                            }
                        }
                    }
                }
            }
        }

        // Right main area
        Rectangle {
            SplitView.fillWidth: true
            color: SpellUI.SpellTheme.background

            Loader {
                id: panelLoader
                anchors.fill: parent
                source: {
                    var panel = root.panels[root.activePanelIndex]
                    if (panel && panel.path) return panel.path
                    return Qt.resolvedUrl("panels/ChatPanel.qml")
                }
            }

            // Error overlay
            Rectangle {
                anchors.fill: parent
                color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.background, 0.9)
                visible: panelLoader.status === Loader.Error

                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: SpellUI.SpellTheme.spacingL

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: "Failed to load panel"
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                        color: SpellUI.SpellTheme.error
                    }

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.maximumWidth: 400
                        text: panelLoader.sourceComponent ? "" : (panelLoader.source + "")
                        font.family: SpellUI.SpellTheme.monoFontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        color: SpellUI.SpellTheme.onSurfaceDim
                        wrapMode: Text.WrapAnywhere
                    }

                    Rectangle {
                        Layout.alignment: Qt.AlignHCenter
                        width: 100
                        height: 36
                        radius: SpellUI.SpellTheme.cornerRadius
                        color: SpellUI.SpellTheme.surfaceHigher

                        Text {
                            anchors.centerIn: parent
                            text: "Retry"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            color: SpellUI.SpellTheme.onSurface
                        }

                        SpellUI.StateLayer {
                            onClicked: {
                                var src = panelLoader.source
                                panelLoader.source = ""
                                panelLoader.source = src
                            }
                        }
                    }
                }
            }

            Connections {
                target: bridge
                function onMessageReceived(payload) {
                    if (panelLoader.item && typeof panelLoader.item.handleMessage === "function") {
                        panelLoader.item.handleMessage(payload)
                    }
                }
            }
        }
    }
}
