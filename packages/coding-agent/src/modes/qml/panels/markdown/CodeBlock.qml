import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Rectangle {
    id: root
    objectName: "codeBlock"
    required property string content
    required property string lang

    signal copyRequested()
    signal saveRequested(string content, string lang)

    width: parent ? parent.width : 0
    height: codeColumn.height
    color: SpellUI.SpellTheme.surfaceHigher
    radius: SpellUI.SpellTheme.cornerRadius

    ColumnLayout {
        id: codeColumn
        width: parent.width
        spacing: 0

        // Header: language label + buttons
        Rectangle {
            objectName: "codeBlockHeader"
            Layout.fillWidth: true
            Layout.preferredHeight: 28
            color: "transparent"

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: SpellUI.SpellTheme.spacingM
                anchors.rightMargin: SpellUI.SpellTheme.spacingM
                spacing: SpellUI.SpellTheme.spacingS

                Text {
                    text: root.lang || "text"
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    color: SpellUI.SpellTheme.textTertiary
                }

                Item { Layout.fillWidth: true }

                // Copy button
                Rectangle {
                    objectName: "copyButton"
                    Layout.preferredWidth: 24
                    Layout.preferredHeight: 24
                    radius: 4
                    color: "transparent"

                    Text {
                        anchors.centerIn: parent
                        text: "\u2398"
                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        color: SpellUI.SpellTheme.textSecondary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.copyRequested()
                    }
                }

                // Save button
                Rectangle {
                    objectName: "saveButton"
                    Layout.preferredWidth: 24
                    Layout.preferredHeight: 24
                    radius: 4
                    color: "transparent"

                    Text {
                        anchors.centerIn: parent
                        text: "\u2913"
                        font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                        color: SpellUI.SpellTheme.textSecondary
                    }

                    SpellUI.StateLayer {
                        onClicked: root.saveRequested(root.content, root.lang)
                    }
                }
            }
        }

        // Code body
        Text {
            Layout.fillWidth: true
            Layout.leftMargin: SpellUI.SpellTheme.spacingM
            Layout.rightMargin: SpellUI.SpellTheme.spacingM
            Layout.bottomMargin: SpellUI.SpellTheme.spacingM
            text: root.content
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            color: SpellUI.SpellTheme.textPrimary
            wrapMode: Text.Wrap
            textFormat: Text.PlainText
        }
    }
}
