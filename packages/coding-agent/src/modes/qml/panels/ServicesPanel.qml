import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    property int totalCount: servicesModel.count
    property int connectedCount: countByStatus("connected")
    property int unknownCount: countByStatus("unknown")

    function updateServices(list) {
        servicesModel.clear()
        if (!list || list.length === undefined) return
        for (var i = 0; i < list.length; i++) {
            var entry = list[i]
            if (!entry || typeof entry !== "object") continue
			servicesModel.append({
				name: String(entry.name || ""),
				displayName: String(entry.displayName || entry.name || ""),
				description: String(entry.description || ""),
				status: String(entry.status || "unknown"),
				profileStorage: String(entry.profileStorage || ""),
				loginUrl: String(entry.loginUrl || ""),
				lastValidated: String(entry.lastValidated || "")
			})
    }

    function countByStatus(status) {
        var count = 0
        for (var i = 0; i < servicesModel.count; i++) {
            if (servicesModel.get(i).status === status) count++
        }
        return count
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
                text: "Connected Services"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                color: SpellUI.SpellTheme.textPrimary
                Layout.fillWidth: true
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
                    text: "Refresh All"
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    color: SpellUI.SpellTheme.textSecondary
                }

                SpellUI.StateLayer {
                    onClicked: bridge.send({ type: "validate_services" })
                }
            }
        }

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
				required property string name
				required property string displayName
				required property string description
				required property string status
				required property string profileStorage
				required property string loginUrl
				required property string lastValidated

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

                    Rectangle {
                        Layout.preferredWidth: 10
                        Layout.preferredHeight: 10
                        Layout.alignment: Qt.AlignVCenter
                        radius: 5
                        color: status === "connected" ? SpellUI.SpellTheme.success : SpellUI.SpellTheme.textTertiary
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2

                        Text {
                            text: displayName
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeS
                            font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                            color: SpellUI.SpellTheme.textPrimary
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }

						Text {
							text: description
							font.family: SpellUI.SpellTheme.fontFamily
							font.pixelSize: SpellUI.SpellTheme.fontSizeXS
							color: SpellUI.SpellTheme.textSecondary
							visible: description.length > 0
							Layout.fillWidth: true
							elide: Text.ElideRight
						}

						Text {
							text: lastValidated.length > 0 ? "Validated: " + lastValidated : "Not validated"
							font.family: SpellUI.SpellTheme.fontFamily
							font.pixelSize: SpellUI.SpellTheme.fontSizeXS
							color: SpellUI.SpellTheme.textTertiary
							Layout.fillWidth: true
							elide: Text.ElideRight
						}
                    }

                    Item { Layout.fillWidth: true }

                    Rectangle {
                        implicitWidth: openLabel.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: openLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: "transparent"
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: openLabel
                            anchors.centerIn: parent
                            text: "Open"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.textSecondary
                        }

                        SpellUI.StateLayer {
                            onClicked: bridge.send({
                                type: "service_open",
                                name: name,
                                storageName: profileStorage,
                                loginUrl: loginUrl
                            })
                        }
                    }

                    Rectangle {
                        implicitWidth: disconnectLabel.implicitWidth + SpellUI.SpellTheme.spacingM
                        implicitHeight: disconnectLabel.implicitHeight + SpellUI.SpellTheme.spacingXS * 2
                        radius: SpellUI.SpellTheme.cornerRadiusSmall
                        color: "transparent"
                        border.width: 1
                        border.color: SpellUI.SpellTheme.borderSubtle

                        Text {
                            id: disconnectLabel
                            anchors.centerIn: parent
                            text: "Disconnect"
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                            color: SpellUI.SpellTheme.error
                        }

                        SpellUI.StateLayer {
                            onClicked: bridge.send({
                                type: "service_disconnect",
                                name: name
                            })
                        }
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            Layout.fillHeight: true
            text: "No connected services"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            color: SpellUI.SpellTheme.textTertiary
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            visible: servicesModel.count === 0
        }
    }
}
