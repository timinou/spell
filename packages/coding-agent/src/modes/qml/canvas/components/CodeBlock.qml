import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root

    required property var codeData

    property string language: {
        if (!codeData || !codeData.language)
            return "text"
        return String(codeData.language)
    }

    property string rawCode: {
        if (!codeData)
            return ""
        if (codeData.code !== undefined)
            return String(codeData.code)
        if (codeData.text !== undefined)
            return String(codeData.text)
        return ""
    }

    property string renderedHtml: {
        if (!codeData || codeData.html === undefined || codeData.html === null)
            return ""
        return String(codeData.html)
    }

    property bool hasRichHtml: renderedHtml.trim().length > 0

    property int bodyHeight: {
        if (!codeData || codeData.height === undefined)
            return 240
        var parsedHeight = Number(codeData.height)
        if (!isFinite(parsedHeight) || parsedHeight <= 0)
            return 240
        return Math.max(120, Math.floor(parsedHeight))
    }

    implicitHeight: codeLayout.implicitHeight

    ColumnLayout {
        id: codeLayout
        anchors.fill: parent
        spacing: SpellUI.SpellTheme.spacingS

        RowLayout {
            Layout.fillWidth: true
            spacing: SpellUI.SpellTheme.spacingS

            Text {
                text: "Code"
                color: SpellUI.SpellTheme.textSecondary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                font.weight: SpellUI.SpellTheme.fontWeightMedium
            }

            Item {
                Layout.fillWidth: true
            }

            Rectangle {
                radius: SpellUI.SpellTheme.cornerRadiusSmall
                color: SpellUI.SpellTheme.surface1
                border.width: 1
                border.color: SpellUI.SpellTheme.borderSubtle
                implicitHeight: languageLabel.implicitHeight + SpellUI.SpellTheme.spacingXS
                implicitWidth: languageLabel.implicitWidth + SpellUI.SpellTheme.spacingS

                Text {
                    id: languageLabel
                    anchors.centerIn: parent
                    text: root.language
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
                }
            }
        }

        Rectangle {
            id: body
            Layout.fillWidth: true
            Layout.preferredHeight: root.bodyHeight
            implicitHeight: root.bodyHeight
            color: SpellUI.SpellTheme.background
            border.width: 1
            border.color: SpellUI.SpellTheme.borderSubtle
            radius: SpellUI.SpellTheme.cornerRadiusSmall

            Flickable {
                id: codeFlickable
                anchors.fill: parent
                anchors.margins: SpellUI.SpellTheme.spacingS
                clip: true
                contentWidth: Math.max(width, codeText.contentWidth + SpellUI.SpellTheme.spacingM)
                contentHeight: Math.max(height, codeText.contentHeight + SpellUI.SpellTheme.spacingM)
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.horizontal: ScrollBar {}
                ScrollBar.vertical: ScrollBar {}

                TextEdit {
                    id: codeText
                    readOnly: true
                    selectByMouse: true
                    text: root.hasRichHtml ? root.renderedHtml : root.rawCode
                    textFormat: root.hasRichHtml ? Text.RichText : Text.PlainText
                    wrapMode: TextEdit.NoWrap
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    x: SpellUI.SpellTheme.spacingXS
                    y: SpellUI.SpellTheme.spacingXS
                    width: Math.max(implicitWidth, codeFlickable.width - SpellUI.SpellTheme.spacingS)
                }
            }
        }
    }
}
