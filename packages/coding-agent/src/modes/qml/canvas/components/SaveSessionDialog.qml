import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Dialog {
    id: root

    modal: true
    title: "Save Browser Session"
    standardButtons: Dialog.Save | Dialog.Cancel

    property string currentDomain: ""
    property var parentServices: []

    property string serviceName: ""
    property string serviceDescription: ""
    property string selectedParent: ""

    signal sessionSaved(var sessionData)

    function openWithDomain(domain: string) {
        currentDomain = domain
        nameField.text = ""
        descField.text = ""
        parentCombo.currentIndex = 0
        serviceName = ""
        serviceDescription = ""
        selectedParent = ""
        open()
    }

    onAccepted: {
        root.sessionSaved({
            name: nameField.text,
            description: descField.text,
            domains: [currentDomain],
            parentService: parentCombo.currentIndex > 0 ? parentServices[parentCombo.currentIndex - 1] : ""
        })
        nameField.text = ""
        descField.text = ""
        parentCombo.currentIndex = 0
    }

    onRejected: {
        nameField.text = ""
        descField.text = ""
        parentCombo.currentIndex = 0
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingM

        Label {
            text: "Service Name"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
        }

        TextField {
            id: nameField
            Layout.fillWidth: true
            maximumLength: 48
            placeholderText: "e.g. GitHub, Vercel"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
            background: Rectangle {
                color: SpellUI.SpellTheme.surface0
                border.color: SpellUI.SpellTheme.overlay0
                border.width: 1
                radius: SpellUI.SpellTheme.cornerRadiusSmall
            }
        }

        Label {
            text: "Description"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
        }

        TextArea {
            id: descField
            Layout.fillWidth: true
            Layout.preferredHeight: 80
            placeholderText: "What is this service used for?"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
            background: Rectangle {
                color: SpellUI.SpellTheme.surface0
                border.color: SpellUI.SpellTheme.overlay0
                border.width: 1
                radius: SpellUI.SpellTheme.cornerRadiusSmall
            }
        }

        Label {
            text: "Domain"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
        }

        TextField {
            id: domainField
            Layout.fillWidth: true
            readOnly: true
            text: root.currentDomain
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.subtext0
            background: Rectangle {
                color: SpellUI.SpellTheme.mantle
                border.color: SpellUI.SpellTheme.overlay0
                border.width: 1
                radius: SpellUI.SpellTheme.cornerRadiusSmall
            }
        }

        Label {
            text: "Parent Service (optional)"
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            color: SpellUI.SpellTheme.text
        }

        ComboBox {
            id: parentCombo
            Layout.fillWidth: true
            model: ["(none)"].concat(root.parentServices)
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
        }
    }
}
