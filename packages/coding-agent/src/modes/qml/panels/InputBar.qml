import QtQuick 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI

Rectangle {
    id: root
    required property bool isStreaming

    signal messageSent(string text)
    signal abortRequested()

    Layout.fillWidth: true
    Layout.preferredHeight: Math.max(52, inputField.contentHeight + SpellUI.SpellTheme.spacingL * 2)
    Layout.maximumHeight: 200
    color: SpellUI.SpellTheme.surface
    border.color: SpellUI.SpellTheme.outline
    border.width: 1

    RowLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingS
        spacing: SpellUI.SpellTheme.spacingS

        // Input field container
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: SpellUI.SpellTheme.cornerRadius
            color: SpellUI.SpellTheme.surfaceHigh

            // Placeholder
            Text {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                text: "Type a message..."
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                color: SpellUI.SpellTheme.textTertiary
                verticalAlignment: Text.AlignVCenter
                visible: inputField.text.length === 0 && !inputField.activeFocus
            }

            Flickable {
                id: inputFlick
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                contentWidth: inputField.paintedWidth
                contentHeight: inputField.paintedHeight
                clip: true

                function ensureVisible(r) {
                    if (contentX >= r.x) contentX = r.x
                    else if (contentX + width <= r.x + r.width) contentX = r.x + r.width - width
                    if (contentY >= r.y) contentY = r.y
                    else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height
                }

                TextEdit {
                    id: inputField
                    width: inputFlick.width
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                    color: SpellUI.SpellTheme.textPrimary
                    selectionColor: SpellUI.SpellTheme.primaryContainer
                    wrapMode: TextEdit.Wrap
                    onCursorRectangleChanged: inputFlick.ensureVisible(cursorRectangle)

                    Keys.onPressed: function(event) {
                        if (event.key === Qt.Key_Return && !(event.modifiers & Qt.ShiftModifier)) {
                            event.accepted = true
                            var text = inputField.text.trim()
                            if (text.length > 0) {
                                inputField.text = ""
                                root.messageSent(text)
                            }
                        }
                    }
                }
            }
        }

        // Send button
        Rectangle {
            Layout.preferredWidth: 36
            Layout.preferredHeight: 36
            Layout.alignment: Qt.AlignBottom
            radius: SpellUI.SpellTheme.cornerRadius
            color: SpellUI.SpellTheme.primary
            visible: !root.isStreaming

            Text {
                anchors.centerIn: parent
                text: "\u2191"
                font.pixelSize: SpellUI.SpellTheme.fontSizeLarge
                font.bold: true
                color: SpellUI.SpellTheme.primaryText
            }

            SpellUI.StateLayer {
                onClicked: {
                    var text = inputField.text.trim()
                    if (text.length > 0) {
                        inputField.text = ""
                        root.messageSent(text)
                    }
                }
            }
        }

        // Abort button
        Rectangle {
            Layout.preferredWidth: 36
            Layout.preferredHeight: 36
            Layout.alignment: Qt.AlignBottom
            radius: SpellUI.SpellTheme.cornerRadius
            color: SpellUI.SpellTheme.error
            visible: root.isStreaming

            Text {
                anchors.centerIn: parent
                text: "\u25A0"
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                color: SpellUI.SpellTheme.primaryText
            }

            SpellUI.StateLayer {
                onClicked: root.abortRequested()
            }
        }
    }
}
