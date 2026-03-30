import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    property bool gatewayError: false
    property bool addFormVisible: false

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object") return
        if (payload.type === "gateway_list_result") {
            gatewayError = false
            servicesModel.clear()
            if (!payload.services || !Array.isArray(payload.services)) return
            for (var i = 0; i < payload.services.length; i++) {
                var entry = payload.services[i]
                if (!entry || typeof entry !== "object") continue
                servicesModel.append({
                    alias: String(entry.alias || ""),
                    target: String(entry.target || ""),
                    status: String(entry.status || "unknown"),
                    persistent: Boolean(entry.persistent)
                })
            }
        } else if (payload.type === "gateway_error") {
            gatewayError = true
        }
    }

    ListModel {
        id: servicesModel
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingM
        spacing: SpellUI.SpellTheme.spacingS

        RowLayout {
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS

            Text {
                text: "Gateway Services"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                color: SpellUI.SpellTheme.textPrimary
                Layout.fillWidth: true
            }

            Rectangle {
                implicitWidth: addLabel.implicitWidth + SpellUI.SpellTheme.spacingL
                implicitHeight: addLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: "transparent"
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle

                Text {
                    id: addLabel
                    anchors.centerIn: parent
                    text: "Add"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }

                SpellUI.StateLayer {
                    onClicked: root.addFormVisible = !root.addFormVisible
                }
            }

            Rectangle {
                implicitWidth: refreshLabel.implicitWidth + SpellUI.SpellTheme.spacingL
                implicitHeight: refreshLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: "transparent"
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle

                Text {
                    id: refreshLabel
                    anchors.centerIn: parent
                    text: "Refresh"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }

                SpellUI.StateLayer {
                    onClicked: bridge.send({ name: "gateway_list" })
                }
            }
        }

        // Inline add form
        Rectangle {
            Layout.fillWidth: true
            visible: root.addFormVisible
            color: SpellUI.SpellTheme.surface0
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle
            implicitHeight: addFormLayout.implicitHeight + SpellUI.SpellTheme.spacingS * 2

            ColumnLayout {
                id: addFormLayout
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                spacing: SpellUI.SpellTheme.spacingXS

                TextField {
                    id: aliasField
                    Layout.fillWidth: true
                    placeholderText: "Alias (e.g. myapp)"
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textPrimary
                    background: Rectangle {
                        color: SpellUI.SpellTheme.background
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        border.width: 1
                        border.color: aliasField.activeFocus ? SpellUI.SpellTheme.accent : SpellUI.SpellTheme.borderSubtle
                    }
                }

                TextField {
                    id: targetField
                    Layout.fillWidth: true
                    placeholderText: "Target URL (e.g. http://localhost:3000)"
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textPrimary
                    background: Rectangle {
                        color: SpellUI.SpellTheme.background
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        border.width: 1
                        border.color: targetField.activeFocus ? SpellUI.SpellTheme.accent : SpellUI.SpellTheme.borderSubtle
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: SpellUI.SpellTheme.spacingS

                    Item { Layout.fillWidth: true }

                    Rectangle {
                        implicitWidth: cancelLabel.implicitWidth + SpellUI.SpellTheme.spacingL
                        implicitHeight: cancelLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: "transparent"
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: cancelLabel
                            anchors.centerIn: parent
                            text: "Cancel"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        SpellUI.StateLayer {
                            onClicked: {
                                root.addFormVisible = false
                                aliasField.text = ""
                                targetField.text = ""
                            }
                        }
                    }

                    Rectangle {
                        implicitWidth: registerLabel.implicitWidth + SpellUI.SpellTheme.spacingL
                        implicitHeight: registerLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: aliasField.text.length > 0 && targetField.text.length > 0 ? SpellUI.SpellTheme.accent : SpellUI.SpellTheme.surface0
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: registerLabel
                            anchors.centerIn: parent
                            text: "Register"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: aliasField.text.length > 0 && targetField.text.length > 0 ? SpellUI.SpellTheme.onAccent : SpellUI.SpellTheme.textTertiary
                        }

                        SpellUI.StateLayer {
                            onClicked: {
                                if (aliasField.text.length === 0 || targetField.text.length === 0) return
                                bridge.send({
                                    name: "gateway_register",
                                    alias: aliasField.text,
                                    target: targetField.text
                                })
                                root.addFormVisible = false
                                aliasField.text = ""
                                targetField.text = ""
                            }
                        }
                    }
                }
            }
        }

        // Error state
        Text {
            Layout.fillWidth: true
            visible: root.gatewayError && servicesModel.count === 0
            text: "Gateway not running — start it with 'spell gateway start'"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            color: SpellUI.SpellTheme.error
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
        }

        // Service list
        ListView {
            id: servicesList
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: servicesModel
            visible: servicesModel.count > 0
            clip: true
            spacing: SpellUI.SpellTheme.spacingXS

            delegate: Rectangle {
                required property int index
                required property string alias
                required property string target
                required property string status
                required property bool persistent

                width: servicesList.width
                implicitHeight: delegateRow.implicitHeight + SpellUI.SpellTheme.spacingS * 2
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: SpellUI.SpellTheme.surface0
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle

                RowLayout {
                    id: delegateRow
                    anchors.fill: parent
                    anchors.margins: SpellUI.SpellTheme.spacingS
                    spacing: SpellUI.SpellTheme.spacingS

                    // Status indicator
                    Rectangle {
                        Layout.preferredWidth: 10
                        Layout.preferredHeight: 10
                        Layout.alignment: Qt.AlignVCenter
                        radius: 5
                        color: status === "active" ? SpellUI.SpellTheme.success
                             : status === "error" ? SpellUI.SpellTheme.error
                             : SpellUI.SpellTheme.textTertiary
                    }

                    // Service info
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2

                        Text {
                            text: alias
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                            color: SpellUI.SpellTheme.textPrimary
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }

                        Text {
                            text: target
                            font.family: SpellUI.SpellTheme.monoFontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.textSecondary
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }
                    }

                    // Open button
                    Rectangle {
                        implicitWidth: openBtnLabel.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: openBtnLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: "transparent"
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: openBtnLabel
                            anchors.centerIn: parent
                            text: "Open"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        SpellUI.StateLayer {
                            onClicked: Qt.openUrlExternally("https://" + alias + ".localhost")
                        }
                    }

                    // Remove button
                    Rectangle {
                        implicitWidth: removeBtnLabel.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: removeBtnLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: "transparent"
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: removeBtnLabel
                            anchors.centerIn: parent
                            text: "Remove"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.error
                        }

                        SpellUI.StateLayer {
                            onClicked: bridge.send({
                                name: "gateway_deregister",
                                alias: alias
                            })
                        }
                    }
                }
            }
        }

        // Empty state
        Text {
            Layout.fillWidth: true
            Layout.fillHeight: true
            text: "No services registered"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            color: SpellUI.SpellTheme.textTertiary
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            visible: servicesModel.count === 0 && !root.gatewayError
        }
    }
}
