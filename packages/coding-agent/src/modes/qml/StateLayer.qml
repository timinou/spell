import QtQuick 2.15
import "." as SpellUI

Rectangle {
    id: root

    signal clicked()
    property bool hovered: mouseArea.containsMouse
    property bool pressed: mouseArea.pressed

    anchors.fill: parent
    radius: parent.radius
    color: "transparent"

    Behavior on color {
        ColorAnimation { duration: SpellUI.SpellTheme.shortDuration }
    }

    states: [
        State {
            name: "pressed"
            when: root.pressed
            PropertyChanges {
                target: root
                color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.textPrimary, SpellUI.SpellTheme.pressOpacity)
            }
        },
        State {
            name: "hovered"
            when: root.hovered
            PropertyChanges {
                target: root
                color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.textPrimary, SpellUI.SpellTheme.hoverOpacity)
            }
        }
    ]

    MouseArea {
        id: mouseArea
        anchors.fill: parent
        hoverEnabled: true
        onClicked: root.clicked()
    }
}
