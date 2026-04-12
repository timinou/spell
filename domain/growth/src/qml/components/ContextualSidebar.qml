import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Rectangle {
    id: root
    color: ShellTheme.SpellTheme.surface0
    border.width: 1
    border.color: ShellTheme.SpellTheme.borderDefault
    radius: ShellTheme.SpellTheme.cornerRadiusLarge

    property var block: null
    property bool busy: false
    property string capability: "interactive"
    property string unsupportedReason: ""

    signal blockTextEdited(string text)
    signal blockKindRequested(string kind, int level)
    signal assetPickerRequested()
    signal variableEdited(string name, string value)
    signal tableCellEdited(int row, int column, string value)
    signal moveRequested(string direction)
    signal deleteRequested()
    signal recoveryRequested()
    signal agentRewriteRequested()
    signal agentInsertRequested()

    function tableRows() {
        if (!root.block || !root.block.meta || !root.block.meta.rows)
            return []
        return root.block.meta.rows
    }

    function variableName() {
        return root.block && root.block.meta && root.block.meta.name ? root.block.meta.name : "variable"
    }

    function variableValue() {
        return root.block && root.block.meta && root.block.meta.value ? root.block.meta.value : "\"\""
    }

    ScrollView {
        anchors.fill: parent
        clip: true

        ColumnLayout {
            width: parent.width
            spacing: ShellTheme.SpellTheme.spacingM
            anchors.margins: ShellTheme.SpellTheme.spacingL

            Text {
                text: "Context"
                color: ShellTheme.SpellTheme.textPrimary
                font.pixelSize: ShellTheme.SpellTheme.fontSizeL
                font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
            }

            Rectangle {
                Layout.fillWidth: true
                radius: ShellTheme.SpellTheme.cornerRadius
                color: root.busy
                    ? Qt.rgba(ShellTheme.SpellTheme.primary.r, ShellTheme.SpellTheme.primary.g, ShellTheme.SpellTheme.primary.b, 0.15)
                    : ShellTheme.SpellTheme.surface1
                border.width: 1
                border.color: root.busy ? ShellTheme.SpellTheme.primary : ShellTheme.SpellTheme.borderSubtle
                implicitHeight: 44

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: ShellTheme.SpellTheme.spacingM
                    spacing: ShellTheme.SpellTheme.spacingS

                    Rectangle {
                        Layout.preferredWidth: 10
                        Layout.preferredHeight: 10
                        radius: 5
                        color: root.busy ? ShellTheme.SpellTheme.primary : ShellTheme.SpellTheme.success
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.busy ? "Agent update in progress" : "Selection ready"
                        color: ShellTheme.SpellTheme.textSecondary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                    }
                }
            }

            Text {
                visible: !root.block
                Layout.fillWidth: true
                text: "Click the visual document to select a paragraph, image, table, or variable panel."
                color: ShellTheme.SpellTheme.textSecondary
                wrapMode: Text.WordWrap
            }

            ColumnLayout {
                visible: !!root.block
                Layout.fillWidth: true
                spacing: ShellTheme.SpellTheme.spacingM

                Rectangle {
                    Layout.fillWidth: true
                    radius: ShellTheme.SpellTheme.cornerRadius
                    color: ShellTheme.SpellTheme.surface1
                    border.width: 1
                    border.color: ShellTheme.SpellTheme.borderSubtle
                    implicitHeight: 78

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: ShellTheme.SpellTheme.spacingM
                        spacing: 4

                        Text {
                            text: root.block ? root.block.kind.replace("_", " ") : ""
                            color: ShellTheme.SpellTheme.textPrimary
                            font.pixelSize: ShellTheme.SpellTheme.fontSizeM
                            font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
                        }

                        Text {
                            text: root.block ? `Anchor ${root.block.anchor}` : ""
                            color: ShellTheme.SpellTheme.textSecondary
                            font.pixelSize: ShellTheme.SpellTheme.fontSizeXS
                        }

                        Text {
                            visible: root.unsupportedReason !== ""
                            text: `Preview-only reason: ${root.unsupportedReason}`
                            color: ShellTheme.SpellTheme.warning
                            font.pixelSize: ShellTheme.SpellTheme.fontSizeXS
                            wrapMode: Text.WordWrap
                        }
                    }
                }

                BlockControls {
                    Layout.fillWidth: true
                    currentKind: root.block ? root.block.kind : "paragraph"
                    currentLevel: root.block && root.block.level ? root.block.level : 1
                    visible: root.block && (root.block.kind === "paragraph" || root.block.kind === "heading" || root.block.kind === "list_item")
                    onBlockKindSelected: function(kind, level) {
                        root.blockKindRequested(kind, level)
                    }
                }

                TextField {
                    visible: root.block && (root.block.kind === "paragraph" || root.block.kind === "heading" || root.block.kind === "list_item")
                    Layout.fillWidth: true
                    text: root.block ? root.block.text : ""
                    placeholderText: "Edit visible content"
                    color: ShellTheme.SpellTheme.textPrimary
                    selectByMouse: true
                    onEditingFinished: root.blockTextEdited(text)
                }

                ColumnLayout {
                    visible: root.block && root.block.kind === "image"
                    Layout.fillWidth: true
                    spacing: ShellTheme.SpellTheme.spacingS

                    Text {
                        text: "Image reference"
                        color: ShellTheme.SpellTheme.textSecondary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                    }

                    TextField {
                        Layout.fillWidth: true
                        text: root.block && root.block.meta && root.block.meta.path ? root.block.meta.path : ""
                        readOnly: true
                        color: ShellTheme.SpellTheme.textPrimary
                    }

                    Button {
                        text: "Replace asset"
                        onClicked: root.assetPickerRequested()
                    }
                }

                ColumnLayout {
                    visible: root.block && root.block.kind === "variable"
                    Layout.fillWidth: true
                    spacing: ShellTheme.SpellTheme.spacingS

                    TextField {
                        id: variableNameField
                        Layout.fillWidth: true
                        text: root.variableName()
                        placeholderText: "Variable name"
                    }

                    TextField {
                        id: variableValueField
                        Layout.fillWidth: true
                        text: root.variableValue()
                        placeholderText: "Value expression"
                    }

                    Button {
                        text: "Apply variable"
                        onClicked: root.variableEdited(variableNameField.text, variableValueField.text)
                    }
                }

                ColumnLayout {
                    visible: root.block && root.block.kind === "table"
                    Layout.fillWidth: true
                    spacing: ShellTheme.SpellTheme.spacingS

                    Text {
                        text: "Table cells"
                        color: ShellTheme.SpellTheme.textSecondary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeS
                    }

                    Repeater {
                        model: root.tableRows()

                        delegate: ColumnLayout {
                            property int rowIndex: index
                            Layout.fillWidth: true
                            spacing: 4

                            Text {
                                text: `Row ${rowIndex + 1}`
                                color: ShellTheme.SpellTheme.textSecondary
                                font.pixelSize: ShellTheme.SpellTheme.fontSizeXS
                            }

                            Repeater {
                                model: modelData

                                delegate: TextField {
                                    Layout.fillWidth: true
                                    text: modelData
                                    placeholderText: `Cell ${index + 1}`
                                    onEditingFinished: root.tableCellEdited(parent.parent.rowIndex, index, text)
                                }
                            }
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: ShellTheme.SpellTheme.spacingS

                    Button {
                        text: "Move up"
                        Layout.fillWidth: true
                        onClicked: root.moveRequested("up")
                    }

                    Button {
                        text: "Move down"
                        Layout.fillWidth: true
                        onClicked: root.moveRequested("down")
                    }
                }

                Button {
                    Layout.fillWidth: true
                    text: "Delete block"
                    onClicked: root.deleteRequested()
                }

                Button {
                    visible: root.capability === "mixed" || root.capability === "recovery_only" || root.unsupportedReason !== ""
                    Layout.fillWidth: true
                    text: "Open hidden source mode"
                    onClicked: root.recoveryRequested()
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: ShellTheme.SpellTheme.spacingS

                    Button {
                        Layout.fillWidth: true
                        text: "Agent rewrite"
                        onClicked: root.agentRewriteRequested()
                    }

                    Button {
                        Layout.fillWidth: true
                        text: "Agent insert"
                        onClicked: root.agentInsertRequested()
                    }
                }
            }
        }
    }
}
