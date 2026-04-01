import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

RowLayout {
    id: root

    spacing: 10

    // Expose current filter state for external reads
    readonly property string searchText: searchField.text
    readonly property string dateRange: dateCombo.currentText
    readonly property bool activeOnly: activeCheck.checked

    function emitFilterChanged() {
        if (typeof bridge !== 'undefined') {
            bridge.send({
                type: 'filter_changed',
                search: searchField.text,
                dateRange: dateCombo.currentText,
                activeOnly: activeCheck.checked
            })
        }
    }

    TextField {
        id: searchField
        Layout.fillWidth: true
        placeholderText: "Search ads, pages, campaigns…"
        font.pixelSize: 13
        color: "#CDD6F4"
        placeholderTextColor: "#6C7086"
        background: Rectangle {
            color: "#1E1E2E"
            border.color: searchField.activeFocus ? "#89B4FA" : "#313244"
            border.width: 1
            radius: 6
        }
        onTextChanged: root.emitFilterChanged()
    }

    ComboBox {
        id: dateCombo
        implicitWidth: 130
        model: ["All time", "Last 7 days", "Last 30 days", "Last 90 days", "This year"]
        font.pixelSize: 13

        contentItem: Text {
            leftPadding: 10
            text: dateCombo.displayText
            font: dateCombo.font
            color: "#CDD6F4"
            verticalAlignment: Text.AlignVCenter
        }

        background: Rectangle {
            color: "#1E1E2E"
            border.color: dateCombo.activeFocus ? "#89B4FA" : "#313244"
            border.width: 1
            radius: 6
        }

        popup: Popup {
            y: dateCombo.height + 2
            width: dateCombo.width
            padding: 4

            background: Rectangle {
                color: "#181825"
                border.color: "#313244"
                border.width: 1
                radius: 6
            }

            contentItem: ListView {
                clip: true
                implicitHeight: contentHeight
                model: dateCombo.delegateModel
            }
        }

        onCurrentTextChanged: root.emitFilterChanged()
    }

    CheckBox {
        id: activeCheck
        text: "Active only"
        font.pixelSize: 13

        contentItem: Text {
            leftPadding: activeCheck.indicator.width + 6
            text: activeCheck.text
            font: activeCheck.font
            color: "#CDD6F4"
            verticalAlignment: Text.AlignVCenter
        }

        onCheckedChanged: root.emitFilterChanged()
    }

    Button {
        text: "Apply"
        font.pixelSize: 13
        implicitWidth: 72
        implicitHeight: 34

        background: Rectangle {
            color: parent.pressed ? "#1e6ef0" : (parent.hovered ? "#3d7bf5" : "#89B4FA")
            radius: 6
        }

        contentItem: Text {
            text: parent.text
            font: parent.font
            color: "#1E1E2E"
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }

        onClicked: root.emitFilterChanged()
    }
}
