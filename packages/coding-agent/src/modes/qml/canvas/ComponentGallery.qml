import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import ".." as SpellUI
import "./components" as Components

ApplicationWindow {
    id: root
    visible: true
    width: windowWidth || 1100
    height: windowHeight || 760
    title: windowTitle || "QML Component Gallery"
    color: SpellUI.SpellTheme.background

    // ── Nav sections ─────────────────────────────────────────────────────────
    readonly property var sections: [
        { id: "markdown", label: "Markdown"  },
        { id: "table",    label: "DataTable" },
        { id: "diff",     label: "DiffView"  },
        { id: "tree",     label: "TreeView"  },
        { id: "prompt",   label: "Prompts"   },
        { id: "palette",  label: "Palette"   },
        { id: "type",     label: "Typography"},
        { id: "spacing",  label: "Spacing"   }
    ]

    property int activeIndex: 0

    RowLayout {
        anchors.fill: parent
        spacing: 0

        // ── Sidebar ───────────────────────────────────────────────────────────
        Rectangle {
            Layout.preferredWidth: 180
            Layout.fillHeight: true
            color: SpellUI.SpellTheme.surface

            Rectangle {
                anchors { right: parent.right; top: parent.top; bottom: parent.bottom }
                width: 1
                color: SpellUI.SpellTheme.outline
            }

            ColumnLayout {
                anchors {
                    fill: parent
                    topMargin: SpellUI.SpellTheme.spacingL
                    leftMargin: SpellUI.SpellTheme.spacingS
                    rightMargin: SpellUI.SpellTheme.spacingS
                    bottomMargin: SpellUI.SpellTheme.spacingS
                }
                spacing: 2

                Text {
                    text: "Gallery"
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    font.bold: true
                    leftPadding: SpellUI.SpellTheme.spacingS
                    Layout.fillWidth: true
                    bottomPadding: SpellUI.SpellTheme.spacingS
                }

                Repeater {
                    model: root.sections

                    delegate: NavItem {
                        required property var modelData
                        required property int index
                        label: modelData.label
                        active: root.activeIndex === index
                        Layout.fillWidth: true
                        onActivated: root.activeIndex = index
                    }
                }

                Item { Layout.fillHeight: true }

                Text {
                    text: "spell canvas v1"
                    color: SpellUI.SpellTheme.textTertiary
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: 10
                    leftPadding: SpellUI.SpellTheme.spacingS
                    bottomPadding: SpellUI.SpellTheme.spacingM
                    Layout.fillWidth: true
                }
            }
        }

        // ── Content area ──────────────────────────────────────────────────────
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: availableWidth

            ColumnLayout {
                // Manual offset for padding since ColumnLayout is not anchored
                x: SpellUI.SpellTheme.spacingXL
                y: SpellUI.SpellTheme.spacingXL
                width: parent.width - SpellUI.SpellTheme.spacingXL * 2
                spacing: SpellUI.SpellTheme.spacingL

                Loader {
                    Layout.fillWidth: true
                    sourceComponent: {
                        var id = root.sections[root.activeIndex].id
                        if (id === "markdown") return markdownSection
                        if (id === "table")    return tableSection
                        if (id === "diff")     return diffSection
                        if (id === "tree")     return treeSection
                        if (id === "prompt")   return promptSection
                        if (id === "palette")  return paletteSection
                        if (id === "type")     return typographySection
                        if (id === "spacing")  return spacingSection
                        return null
                    }
                }

                // Bottom spacer so content doesn't hard-clip
                Item { implicitHeight: SpellUI.SpellTheme.spacingXL }
            }
        }
    }

    // ── Sections ──────────────────────────────────────────────────────────────

    Component {
        id: markdownSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingL

            SectionHeader { title: "Markdown" }

            ShowcaseCard {
                label: "Rich text rendering"
                Layout.fillWidth: true
                contentItem: Text {
                    text: "# Heading 1\n## Heading 2\n\nParagraph with **bold**, *italic*, and `inline code`.\n\n- List item A\n- List item B\n\n> Blockquote: *The quick brown fox jumps over the lazy dog*"
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                    wrapMode: Text.Wrap
                    textFormat: Text.MarkdownText
                    width: parent ? parent.width : 0
                }
            }
        }
    }

    Component {
        id: tableSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingL

            SectionHeader { title: "DataTable" }

            ShowcaseCard {
                label: "Sortable columns — click a header to sort"
                Layout.fillWidth: true
                contentItem: Components.DataTable {
                    width: parent ? parent.width : 0
                    tableData: ({
                        columns: [
                            { key: "pkg",     label: "Package",    width: 220 },
                            { key: "lang",    label: "Language",   width: 110 },
                            { key: "size",    label: "Size (KB)",  width: 100 },
                            { key: "version", label: "Version",    width: 100 }
                        ],
                        rows: [
                            { pkg: "@oh-my-pi/agent",        lang: "TypeScript", size: 42,  version: "0.14.0" },
                            { pkg: "@oh-my-pi/coding-agent", lang: "TypeScript", size: 310, version: "0.14.0" },
                            { pkg: "@oh-my-pi/tui",          lang: "TypeScript", size: 88,  version: "0.14.0" },
                            { pkg: "@oh-my-pi/natives",      lang: "Rust/TS",    size: 24,  version: "0.14.0" },
                            { pkg: "@oh-my-pi/stats",        lang: "TypeScript", size: 56,  version: "0.14.0" },
                            { pkg: "@oh-my-pi/utils",        lang: "TypeScript", size: 18,  version: "0.14.0" }
                        ],
                        sortable: true
                    })
                }
            }
        }
    }

    Component {
        id: diffSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingL

            SectionHeader { title: "DiffView" }

            ShowcaseCard {
                label: "Unified diff with hunk approve/reject"
                Layout.fillWidth: true
                contentItem: Components.DiffView {
                    width: parent ? parent.width : 0
                    diffData: ({
                        filename: "packages/coding-agent/src/tools/edit.ts",
                        hunks: [
                            {
                                header: "@@ -12,7 +12,10 @@",
                                lines: [
                                    { type: "context", text: "  import * as fs from \"node:fs/promises\"" },
                                    { type: "context", text: "  import * as path from \"node:path\"" },
                                    { type: "remove",  text: "  const MAX_RETRIES = 3" },
                                    { type: "add",     text: "  const MAX_RETRIES = 5" },
                                    { type: "add",     text: "  const RETRY_DELAY_MS = 200" },
                                    { type: "context", text: "" },
                                    { type: "context", text: "  export async function applyEdit(op: EditOp): Promise<void> {" }
                                ]
                            },
                            {
                                header: "@@ -45,4 +48,6 @@",
                                lines: [
                                    { type: "context", text: "    const result = await attempt(op)" },
                                    { type: "remove",  text: "    return result" },
                                    { type: "add",     text: "    if (!result.ok) throw new EditError(result.reason)" },
                                    { type: "add",     text: "    return result.value" },
                                    { type: "context", text: "  }" }
                                ]
                            }
                        ]
                    })
                }
            }
        }
    }

    Component {
        id: treeSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingL

            SectionHeader { title: "TreeView" }

            ShowcaseCard {
                label: "Expandable file tree — click nodes to expand/collapse"
                Layout.fillWidth: true
                contentItem: Components.TreeView {
                    width: parent ? parent.width : 0
                    treeData: ({
                        nodes: [
                            {
                                id: "packages", label: "packages", icon: "folder", expanded: true,
                                children: [
                                    {
                                        id: "coding-agent", label: "coding-agent", icon: "folder", expanded: true,
                                        children: [
                                            {
                                                id: "src", label: "src", icon: "folder", expanded: false,
                                                children: [
                                                    { id: "main", label: "main.ts",  icon: "file" },
                                                    { id: "cli",  label: "cli.ts",   icon: "file" }
                                                ]
                                            },
                                            { id: "pkg-json", label: "package.json", icon: "file" }
                                        ]
                                    },
                                    {
                                        id: "tui", label: "tui", icon: "folder", expanded: false,
                                        children: [{ id: "tui-src", label: "src", icon: "folder" }]
                                    },
                                    { id: "utils", label: "utils", icon: "folder", expanded: false, children: [] }
                                ]
                            },
                            {
                                id: "crates", label: "crates", icon: "folder", expanded: false,
                                children: [{ id: "pi-natives", label: "pi-natives", icon: "folder" }]
                            }
                        ]
                    })
                }
            }
        }
    }

    Component {
        id: promptSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingL

            SectionHeader { title: "Prompts" }

            ShowcaseCard {
                label: "Radio — single selection"
                Layout.fillWidth: true
                contentItem: PromptWidget {
                    promptType: "radio"
                    question: "Which renderer should we use?"
                    options: ["WebGPU", "Metal", "Vulkan", "OpenGL"]
                    width: parent ? parent.width : 0
                }
            }

            ShowcaseCard {
                label: "Checkbox — multiple selection"
                Layout.fillWidth: true
                contentItem: PromptWidget {
                    promptType: "checkbox"
                    question: "Which packages need updates?"
                    options: ["@oh-my-pi/agent", "@oh-my-pi/tui", "@oh-my-pi/natives", "@oh-my-pi/utils"]
                    width: parent ? parent.width : 0
                }
            }

            ShowcaseCard {
                label: "Text — free input"
                Layout.fillWidth: true
                contentItem: PromptWidget {
                    promptType: "text"
                    question: "Enter a commit message:"
                    options: []
                    width: parent ? parent.width : 0
                }
            }
        }
    }

    Component {
        id: paletteSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingS

            SectionHeader { title: "Color Palette" }

            SwatchRow { label: "background";      swatch: SpellUI.SpellTheme.background;      hex: "#0e1117" }
            SwatchRow { label: "surface";         swatch: SpellUI.SpellTheme.surface;         hex: "#161b22" }
            SwatchRow { label: "surfaceHigh";     swatch: SpellUI.SpellTheme.surfaceHigh;     hex: "#1c2129" }
            SwatchRow { label: "surfaceHigher";   swatch: SpellUI.SpellTheme.surfaceHigher;   hex: "#242a33" }
            SwatchRow { label: "outline";         swatch: SpellUI.SpellTheme.outline;         hex: "#30363d" }
            SwatchRow { label: "outlineVariant";  swatch: SpellUI.SpellTheme.outlineVariant;  hex: "#21262d" }

            DividerLine {}

            SwatchRow { label: "textPrimary";   swatch: SpellUI.SpellTheme.textPrimary;   hex: "#e6edf3" }
            SwatchRow { label: "textSecondary"; swatch: SpellUI.SpellTheme.textSecondary; hex: "#8b949e" }
            SwatchRow { label: "textTertiary";  swatch: SpellUI.SpellTheme.textTertiary;  hex: "#484f58" }

            DividerLine {}

            SwatchRow { label: "primary";          swatch: SpellUI.SpellTheme.primary;          hex: "#e8a040" }
            SwatchRow { label: "primaryContainer"; swatch: SpellUI.SpellTheme.primaryContainer; hex: "#3d2800" }
            SwatchRow { label: "error";            swatch: SpellUI.SpellTheme.error;            hex: "#f85149" }
            SwatchRow { label: "success";          swatch: SpellUI.SpellTheme.success;          hex: "#3fb950" }
            SwatchRow { label: "warning";          swatch: SpellUI.SpellTheme.warning;          hex: "#d29922" }
        }
    }

    Component {
        id: typographySection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingS

            SectionHeader { title: "Typography" }

            TypeRow { label: "Inter / title (20)";  pixelSize: SpellUI.SpellTheme.fontSizeTitle;  mono: false; sample: "The quick brown fox" }
            TypeRow { label: "Inter / large (16)";  pixelSize: SpellUI.SpellTheme.fontSizeLarge;  mono: false; sample: "The quick brown fox" }
            TypeRow { label: "Inter / medium (14)"; pixelSize: SpellUI.SpellTheme.fontSizeMedium; mono: false; sample: "The quick brown fox" }
            TypeRow { label: "Inter / small (12)";  pixelSize: SpellUI.SpellTheme.fontSizeSmall;  mono: false; sample: "The quick brown fox" }

            DividerLine {}

            TypeRow { label: "Fira Code / title (20)";  pixelSize: SpellUI.SpellTheme.fontSizeTitle;  mono: true; sample: "fn main() -> Result<()>" }
            TypeRow { label: "Fira Code / large (16)";  pixelSize: SpellUI.SpellTheme.fontSizeLarge;  mono: true; sample: "fn main() -> Result<()>" }
            TypeRow { label: "Fira Code / medium (14)"; pixelSize: SpellUI.SpellTheme.fontSizeMedium; mono: true; sample: "fn main() -> Result<()>" }
            TypeRow { label: "Fira Code / small (12)";  pixelSize: SpellUI.SpellTheme.fontSizeSmall;  mono: true; sample: "fn main() -> Result<()>" }
        }
    }

    Component {
        id: spacingSection
        ColumnLayout {
            spacing: SpellUI.SpellTheme.spacingM

            SectionHeader { title: "Spacing" }

            SpacingRow { label: "spacingXS"; sz: SpellUI.SpellTheme.spacingXS }
            SpacingRow { label: "spacingS";  sz: SpellUI.SpellTheme.spacingS  }
            SpacingRow { label: "spacingM";  sz: SpellUI.SpellTheme.spacingM  }
            SpacingRow { label: "spacingL";  sz: SpellUI.SpellTheme.spacingL  }
            SpacingRow { label: "spacingXL"; sz: SpellUI.SpellTheme.spacingXL }

            DividerLine {}

            SectionHeader { title: "Corner Radii" }

            RadiusRow { label: "cornerRadiusSmall"; sz: SpellUI.SpellTheme.cornerRadiusSmall }
            RadiusRow { label: "cornerRadius";      sz: SpellUI.SpellTheme.cornerRadius      }
            RadiusRow { label: "cornerRadiusLarge"; sz: SpellUI.SpellTheme.cornerRadiusLarge }
        }
    }

    // ── Reusable inline components ────────────────────────────────────────────

    component NavItem: Rectangle {
        id: nav
        required property string label
        required property bool active
        signal activated()

        implicitHeight: 36
        radius: SpellUI.SpellTheme.cornerRadiusSmall
        color: nav.active  ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.18)
             : nav.hovered ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.textPrimary, 0.06)
             : "transparent"

        property bool hovered: false

        Rectangle {
            visible: nav.active
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
            width: 3; radius: 2
            color: SpellUI.SpellTheme.primary
        }

        Text {
            anchors { verticalCenter: parent.verticalCenter; left: parent.left; leftMargin: 12 }
            text: nav.label
            color: nav.active ? SpellUI.SpellTheme.primary : SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            font.bold: nav.active
        }

        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: nav.hovered = true
            onExited:  nav.hovered = false
            onClicked: nav.activated()
        }
    }

    component SectionHeader: Text {
        required property string title
        text: title
        color: SpellUI.SpellTheme.textPrimary
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeTitle
        font.bold: true
        Layout.fillWidth: true
        bottomPadding: SpellUI.SpellTheme.spacingXS
    }

    component DividerLine: Rectangle {
        implicitHeight: 1
        Layout.fillWidth: true
        color: SpellUI.SpellTheme.outline
    }

    component ShowcaseCard: Rectangle {
        id: card
        required property string label
        property alias contentItem: inner.data

        implicitHeight: cardHeader.implicitHeight + SpellUI.SpellTheme.spacingM
                        + inner.implicitHeight + SpellUI.SpellTheme.spacingM * 2
        color: SpellUI.SpellTheme.surface
        radius: SpellUI.SpellTheme.cornerRadius
        border.color: SpellUI.SpellTheme.outline
        border.width: 1

        ColumnLayout {
            anchors { fill: parent; margins: SpellUI.SpellTheme.spacingM }
            spacing: SpellUI.SpellTheme.spacingM

            RowLayout {
                id: cardHeader
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle { implicitWidth: 3; implicitHeight: 14; radius: 2; color: SpellUI.SpellTheme.primary }
                Text {
                    text: card.label
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
                    font.bold: true
                }
            }

            Item {
                id: inner
                Layout.fillWidth: true
                implicitHeight: childrenRect.height
            }
        }
    }

    component SwatchRow: RowLayout {
        required property string label
        required property color swatch
        required property string hex
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingM
        implicitHeight: 36

        Rectangle {
            implicitWidth: 100; implicitHeight: 28
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: swatch
            border.color: SpellUI.SpellTheme.outline
            border.width: 1
        }
        Text {
            text: label
            color: SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            Layout.preferredWidth: 200
        }
        Text {
            text: hex
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
        }
    }

    component TypeRow: RowLayout {
        required property string label
        required property int pixelSize
        required property bool mono
        required property string sample
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingL
        implicitHeight: pixelSize + 12

        Text {
            text: label
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            Layout.preferredWidth: 220
        }
        Text {
            text: sample
            color: SpellUI.SpellTheme.textPrimary
            font.family: mono ? SpellUI.SpellTheme.monoFontFamily : SpellUI.SpellTheme.fontFamily
            font.pixelSize: pixelSize
            Layout.fillWidth: true
        }
    }

    component SpacingRow: RowLayout {
        required property string label
        required property int sz
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingL
        implicitHeight: Math.max(sz, 16) + 8

        Text {
            text: label + "  (" + sz + "px)"
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            Layout.preferredWidth: 220
        }
        Rectangle {
            implicitWidth: sz; implicitHeight: sz
            color: SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.55)
            radius: 2
        }
        Item { Layout.fillWidth: true }
    }

    component RadiusRow: RowLayout {
        required property string label
        required property int sz
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingL
        implicitHeight: 52

        Text {
            text: label + "  (" + sz + "px)"
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            Layout.preferredWidth: 220
        }
        Rectangle {
            implicitWidth: 80; implicitHeight: 36
            radius: sz
            color: SpellUI.SpellTheme.surfaceHigh
            border.color: SpellUI.SpellTheme.primary
            border.width: 1
        }
        Item { Layout.fillWidth: true }
    }

    component PromptWidget: Rectangle {
        id: pw
        required property string promptType
        required property string question
        required property var options
        property bool answered: false
        property var response: null

        implicitHeight: pwCol.implicitHeight + SpellUI.SpellTheme.spacingM * 2
        color: SpellUI.SpellTheme.surfaceHigh
        radius: SpellUI.SpellTheme.cornerRadius

        ColumnLayout {
            id: pwCol
            anchors { fill: parent; margins: SpellUI.SpellTheme.spacingM }
            spacing: SpellUI.SpellTheme.spacingS
            enabled: !pw.answered

            Text {
                text: pw.question
                color: SpellUI.SpellTheme.textPrimary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                font.bold: true
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }

            // Radio
            Loader {
                active: pw.promptType === "radio"
                Layout.fillWidth: true
                sourceComponent: Column {
                    spacing: SpellUI.SpellTheme.spacingXS
                    ButtonGroup { id: pwRadioGroup }
                    Repeater {
                        model: pw.options
                        delegate: RadioButton {
                            required property string modelData
                            text: modelData
                            ButtonGroup.group: pwRadioGroup
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            onClicked: { pw.answered = true; pw.response = modelData }
                        }
                    }
                }
            }

            // Checkbox
            Loader {
                active: pw.promptType === "checkbox"
                Layout.fillWidth: true
                sourceComponent: Column {
                    id: cbCol
                    spacing: SpellUI.SpellTheme.spacingXS
                    property var selected: []
                    Repeater {
                        model: pw.options
                        delegate: CheckBox {
                            required property string modelData
                            text: modelData
                            font.family: SpellUI.SpellTheme.fontFamily
                            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                            onToggled: {
                                var s = cbCol.selected.slice()
                                if (checked) {
                                    s.push(modelData)
                                } else {
                                    var i = s.indexOf(modelData)
                                    if (i >= 0) s.splice(i, 1)
                                }
                                cbCol.selected = s
                            }
                        }
                    }
                    Button {
                        text: "Submit"
                        onClicked: { pw.answered = true; pw.response = cbCol.selected }
                    }
                }
            }

            // Text input
            Loader {
                active: pw.promptType === "text"
                Layout.fillWidth: true
                sourceComponent: RowLayout {
                    spacing: SpellUI.SpellTheme.spacingS
                    TextField {
                        id: pwField
                        Layout.fillWidth: true
                        placeholderText: "Type your response..."
                        font.family: SpellUI.SpellTheme.fontFamily
                        font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
                        color: SpellUI.SpellTheme.textPrimary
                        background: Rectangle {
                            color: SpellUI.SpellTheme.surface
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            border.color: SpellUI.SpellTheme.outline
                            border.width: 1
                        }
                        onAccepted: pwSend.clicked()
                    }
                    Button {
                        id: pwSend
                        text: "Submit"
                        onClicked: {
                            if (pwField.text.length > 0) {
                                pw.answered = true
                                pw.response = pwField.text
                            }
                        }
                    }
                }
            }

            Text {
                visible: pw.answered
                text: "Answered: " + JSON.stringify(pw.response)
                color: SpellUI.SpellTheme.success
                font.family: SpellUI.SpellTheme.monoFontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeSmall
            }
        }
    }
}
