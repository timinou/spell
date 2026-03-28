import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Rectangle {
    id: root
    objectName: "flowInputBar"

    required property bool isStreaming

    signal messageSent(string text)
    signal abortRequested()

    Layout.fillWidth: true
    implicitHeight: Math.max(52, inputField.contentHeight + SpellUI.SpellTheme.spacingM * 2)
    radius: SpellUI.SpellTheme.cornerRadiusSmall
    color: SpellUI.SpellTheme.surface0
    border.width: 1
    border.color: SpellUI.SpellTheme.borderSubtle

    RowLayout {
        anchors.fill: parent
        anchors.margins: SpellUI.SpellTheme.spacingS
        spacing: SpellUI.SpellTheme.spacingS

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: "transparent"

            Text {
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                text: "Ask, steer, or refine the research"
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
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

                function ensureVisible(rectangle) {
                    if (contentX >= rectangle.x) contentX = rectangle.x
                    else if (contentX + width <= rectangle.x + rectangle.width) contentX = rectangle.x + rectangle.width - width
                    if (contentY >= rectangle.y) contentY = rectangle.y
                    else if (contentY + height <= rectangle.y + rectangle.height) contentY = rectangle.y + rectangle.height - height
                }

                TextEdit {
                    id: inputField
                    width: inputFlick.width
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    color: SpellUI.SpellTheme.textPrimary
                    selectionColor: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.24)
                    wrapMode: TextEdit.Wrap
                    onCursorRectangleChanged: inputFlick.ensureVisible(cursorRectangle)

                    Keys.onPressed: function(event) {
                        if (event.key === Qt.Key_Return && !(event.modifiers & Qt.ShiftModifier)) {
                            event.accepted = true
                            var nextText = inputField.text.trim()
                            if (nextText.length > 0) {
                                inputField.text = ""
                                root.messageSent(nextText)
                            }
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.preferredWidth: 36
            Layout.preferredHeight: 36
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: root.isStreaming ? SpellUI.SpellTheme.error : SpellUI.SpellTheme.surface1
            border.width: 1
            border.color: root.isStreaming ? SpellUI.SpellTheme.error : SpellUI.SpellTheme.borderSubtle

            Text {
                anchors.centerIn: parent
                text: root.isStreaming ? "■" : "↵"
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeM
                color: root.isStreaming ? SpellUI.SpellTheme.primaryText : SpellUI.SpellTheme.textPrimary
            }

            SpellUI.StateLayer {
                onClicked: {
                    if (root.isStreaming) {
                        root.abortRequested()
                        return
                    }
                    var nextText = inputField.text.trim()
                    if (nextText.length > 0) {
                        inputField.text = ""
                        root.messageSent(nextText)
                    }
                }
            }
        }
    }
}
