import QtQuick 2.15
import QtQuick.Controls 2.15
import ".." as SpellUI

Text {
    id: root
    property bool enabled: false
    property double nowMs: 0
    property double autoApproveAt: 0
    text: !enabled || autoApproveAt <= 0 ? "Auto-approve off" : "Auto-approve in " + Math.max(0, Math.ceil((autoApproveAt - nowMs) / 1000)) + "s"
    font.family: SpellUI.SpellTheme.fontFamily
    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
    color: enabled ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textSecondary
}
