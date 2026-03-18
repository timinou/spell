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
            color: SpellUI.SpellTheme.surface0

            Rectangle {
                anchors { right: parent.right; top: parent.top; bottom: parent.bottom }
                width: 1
                color: SpellUI.SpellTheme.borderSubtle
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
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    font.letterSpacing: SpellUI.SpellTheme.trackingWide
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
                    color: SpellUI.SpellTheme.textGhost
                    font.family: SpellUI.SpellTheme.monoFontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeXS
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
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
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

            SwatchRow { label: "background";    swatch: SpellUI.SpellTheme.background;    hex: "#0d1117" }
            SwatchRow { label: "surface0";      swatch: SpellUI.SpellTheme.surface0;      hex: "#151b23" }
            SwatchRow { label: "surface1";      swatch: SpellUI.SpellTheme.surface1;      hex: "#1e252e" }
            SwatchRow { label: "surface2";      swatch: SpellUI.SpellTheme.surface2;      hex: "#2a3240" }
            SwatchRow { label: "borderSubtle"; swatch: SpellUI.SpellTheme.borderSubtle; hex: "#253040" }
            SwatchRow { label: "borderDefault";swatch: SpellUI.SpellTheme.borderDefault;hex: "#3a4556" }
            SwatchRow { label: "borderStrong"; swatch: SpellUI.SpellTheme.borderStrong; hex: "#4f5d73" }

            DividerLine {}

            SwatchRow { label: "textPrimary";   swatch: SpellUI.SpellTheme.textPrimary;   hex: "#e6edf3" }
            SwatchRow { label: "textSecondary"; swatch: SpellUI.SpellTheme.textSecondary; hex: "#8b949e" }
            SwatchRow { label: "textTertiary";  swatch: SpellUI.SpellTheme.textTertiary;  hex: "#6e7681" }
            SwatchRow { label: "textGhost";     swatch: SpellUI.SpellTheme.textGhost;     hex: "#484f58" }

            DividerLine {}

            SwatchRow { label: "diffAddBg";    swatch: SpellUI.SpellTheme.diffAddBg();    hex: "rgba(46,160,67,0.15)" }
            SwatchRow { label: "diffRemoveBg"; swatch: SpellUI.SpellTheme.diffRemoveBg(); hex: "rgba(248,81,73,0.15)" }
            SwatchRow { label: "diffHunkBg";   swatch: SpellUI.SpellTheme.diffHunkBg();   hex: "rgba(56,139,253,0.10)" }

            DividerLine {}
            Text {
                text: "Deprecated (compatibility aliases)"
                color: SpellUI.SpellTheme.textGhost
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                font.weight: SpellUI.SpellTheme.fontWeightMedium
                Layout.topMargin: SpellUI.SpellTheme.spacingXS
            }
            SwatchRow { label: "surface";        swatch: SpellUI.SpellTheme.surface;        hex: "#161b22"; muted: true }
            SwatchRow { label: "surfaceHigh";    swatch: SpellUI.SpellTheme.surfaceHigh;    hex: "#1c2129"; muted: true }
            SwatchRow { label: "surfaceHigher";  swatch: SpellUI.SpellTheme.surfaceHigher;  hex: "#242a33"; muted: true }
            SwatchRow { label: "outline";        swatch: SpellUI.SpellTheme.outline;        hex: "#30363d"; muted: true }
            SwatchRow { label: "outlineVariant"; swatch: SpellUI.SpellTheme.outlineVariant; hex: "#21262d"; muted: true }

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

            TypeRow { label: "Inter XS (11)";       pixelSize: SpellUI.SpellTheme.fontSizeXS;      mono: false; sample: "Control caption 11px"; tracking: SpellUI.SpellTheme.trackingWide }
            TypeRow { label: "Inter S (12)";        pixelSize: SpellUI.SpellTheme.fontSizeS;       mono: false; sample: "Secondary label 12px"; tracking: SpellUI.SpellTheme.trackingWide }
            TypeRow { label: "Inter Caption (13)";  pixelSize: SpellUI.SpellTheme.fontSizeCaption; mono: false; sample: "Caption text 13px" }
            TypeRow { label: "Inter M (14)";        pixelSize: SpellUI.SpellTheme.fontSizeM;       mono: false; sample: "Body text 14px for sustained reading" }
            TypeRow { label: "Inter L (16)";        pixelSize: SpellUI.SpellTheme.fontSizeL;       mono: false; sample: "Prompt question / emphasized body"; weight: SpellUI.SpellTheme.fontWeightSemiBold }
            TypeRow { label: "Inter XL (20)";       pixelSize: SpellUI.SpellTheme.fontSizeXL;      mono: false; sample: "Section header"; weight: SpellUI.SpellTheme.fontWeightSemiBold; tracking: SpellUI.SpellTheme.trackingTight }
            TypeRow { label: "Inter XXL (26)";      pixelSize: SpellUI.SpellTheme.fontSizeXXL;     mono: false; sample: "Page title"; weight: SpellUI.SpellTheme.fontWeightBold; tracking: SpellUI.SpellTheme.trackingTight }

            DividerLine {}
            TypeRow { label: "Weight Light (300)";    pixelSize: SpellUI.SpellTheme.fontSizeL; mono: false; sample: "Weight sample"; weight: SpellUI.SpellTheme.fontWeightLight }
            TypeRow { label: "Weight Regular (400)";  pixelSize: SpellUI.SpellTheme.fontSizeL; mono: false; sample: "Weight sample"; weight: SpellUI.SpellTheme.fontWeightRegular }
            TypeRow { label: "Weight Medium (500)";   pixelSize: SpellUI.SpellTheme.fontSizeL; mono: false; sample: "Weight sample"; weight: SpellUI.SpellTheme.fontWeightMedium }
            TypeRow { label: "Weight SemiBold (600)"; pixelSize: SpellUI.SpellTheme.fontSizeL; mono: false; sample: "Weight sample"; weight: SpellUI.SpellTheme.fontWeightSemiBold }
            TypeRow { label: "Weight Bold (700)";     pixelSize: SpellUI.SpellTheme.fontSizeL; mono: false; sample: "Weight sample"; weight: SpellUI.SpellTheme.fontWeightBold }

            DividerLine {}
            TypeRow { label: "Fira Code S + lineHeightMono"; pixelSize: SpellUI.SpellTheme.fontSizeS; mono: true; sample: "const retryDelayMs = 200 // line-height demo"; lineHeight: SpellUI.SpellTheme.lineHeightMono }
            TypeRow { label: "Inter M + lineHeightBody";      pixelSize: SpellUI.SpellTheme.fontSizeM; mono: false; sample: "Body copy uses lineHeightBody for readability."; lineHeight: SpellUI.SpellTheme.lineHeightBody }
            TypeRow { label: "Inter XL + lineHeightHeading";  pixelSize: SpellUI.SpellTheme.fontSizeXL; mono: false; sample: "Heading rhythm"; lineHeight: SpellUI.SpellTheme.lineHeightHeading; tracking: SpellUI.SpellTheme.trackingTight; weight: SpellUI.SpellTheme.fontWeightSemiBold }
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
        color: nav.active ? SpellUI.SpellTheme.surface2 : (nav.hovered ? SpellUI.SpellTheme.surface1 : "transparent")
        border.width: nav.active || nav.hovered ? 1 : 0
        border.color: nav.active ? SpellUI.SpellTheme.borderDefault : SpellUI.SpellTheme.borderSubtle
        property bool hovered: false

        Rectangle {
            visible: nav.active
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
            width: 2
            color: SpellUI.SpellTheme.primary
        }

        Text {
            anchors { verticalCenter: parent.verticalCenter; left: parent.left; leftMargin: 12 }
            text: nav.label
            color: nav.active ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            font.weight: nav.active ? SpellUI.SpellTheme.fontWeightMedium : SpellUI.SpellTheme.fontWeightRegular
            font.letterSpacing: SpellUI.SpellTheme.trackingWide
        }

        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onEntered: nav.hovered = true
            onExited: nav.hovered = false
            onClicked: nav.activated()
        }
    }

    component SectionHeader: Text {
        required property string title
        text: title
        color: SpellUI.SpellTheme.textPrimary
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeXL
        font.weight: SpellUI.SpellTheme.fontWeightSemiBold
        font.letterSpacing: SpellUI.SpellTheme.trackingTight
        Layout.fillWidth: true
        bottomPadding: SpellUI.SpellTheme.spacingXS
    }

    component DividerLine: Rectangle {
        implicitHeight: 1
        Layout.fillWidth: true
        color: SpellUI.SpellTheme.borderSubtle
    }

    component ShowcaseCard: Rectangle {
        id: card
        required property string label
        property alias contentItem: inner.data

        implicitHeight: cardHeader.implicitHeight + SpellUI.SpellTheme.spacingM + inner.implicitHeight + SpellUI.SpellTheme.spacingM * 2
        color: SpellUI.SpellTheme.surface0
        radius: SpellUI.SpellTheme.cornerRadius
        border.color: SpellUI.SpellTheme.borderDefault
        border.width: 1

        Rectangle {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            color: SpellUI.SpellTheme.borderDefault
        }

        ColumnLayout {
            anchors { fill: parent; margins: SpellUI.SpellTheme.spacingM }
            spacing: SpellUI.SpellTheme.spacingM

            RowLayout {
                id: cardHeader
                Layout.fillWidth: true
                spacing: SpellUI.SpellTheme.spacingS

                Rectangle {
                    implicitWidth: 3
                    implicitHeight: 14
                    radius: 2
                    color: SpellUI.SpellTheme.primary
                }
                Text {
                    text: card.label
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    font.weight: SpellUI.SpellTheme.fontWeightMedium
                    font.letterSpacing: SpellUI.SpellTheme.trackingWide
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
        property bool muted: false
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingM
        implicitHeight: 36
        opacity: muted ? 0.68 : 1

        Rectangle {
            implicitWidth: 100
            implicitHeight: 28
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: swatch
            border.color: SpellUI.SpellTheme.borderDefault
            border.width: 1
        }
        Text {
            text: label
            color: muted ? SpellUI.SpellTheme.textSecondary : SpellUI.SpellTheme.textPrimary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeM
            Layout.preferredWidth: 220
        }
        Text {
            text: hex
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
        }
    }

    component TypeRow: RowLayout {
        required property string label
        required property int pixelSize
        required property bool mono
        required property string sample
        property int weight: SpellUI.SpellTheme.fontWeightRegular
        property real tracking: SpellUI.SpellTheme.trackingNormal
        property real lineHeight: mono ? SpellUI.SpellTheme.lineHeightMono : SpellUI.SpellTheme.lineHeightBody
        Layout.fillWidth: true
        spacing: SpellUI.SpellTheme.spacingL
        implicitHeight: Math.max(pixelSize + 12, 34)

        Text {
            text: label
            color: SpellUI.SpellTheme.textSecondary
            font.family: SpellUI.SpellTheme.monoFontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            Layout.preferredWidth: 260
        }
        Text {
            text: sample
            color: SpellUI.SpellTheme.textPrimary
            font.family: mono ? SpellUI.SpellTheme.monoFontFamily : SpellUI.SpellTheme.fontFamily
            font.pixelSize: pixelSize
            font.weight: weight
            font.letterSpacing: mono ? 0 : tracking
            lineHeightMode: Text.ProportionalHeight
            lineHeight: lineHeight
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
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            Layout.preferredWidth: 220
        }
        Rectangle {
            implicitWidth: sz
            implicitHeight: sz
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
            font.pixelSize: SpellUI.SpellTheme.fontSizeS
            Layout.preferredWidth: 220
        }
        Rectangle {
            implicitWidth: 80
            implicitHeight: 36
            radius: sz
            color: SpellUI.SpellTheme.surface1
            border.color: SpellUI.SpellTheme.borderDefault
            border.width: 1
        }
        Item { Layout.fillWidth: true }
    }

    component PromptFocusRing: Rectangle {
        required property bool focused
        required property real baseRadius
        anchors.fill: parent
        anchors.margins: -2
        color: "transparent"
        border.width: 2
        border.color: SpellUI.SpellTheme.primary
        radius: baseRadius + 2
        visible: focused
    }

    component PromptButton: Button {
        id: control
        hoverEnabled: true
        implicitHeight: 36
        implicitWidth: 96
        leftPadding: 16
        rightPadding: 16
        topPadding: 8
        bottomPadding: 8
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightMedium
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        background: Rectangle {
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            border.width: 1
            border.color: control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault
            color: control.down ? SpellUI.SpellTheme.surface2 : SpellUI.SpellTheme.surface1
            scale: control.down ? 0.97 : 1
            transformOrigin: Item.Center

            Behavior on border.color { ColorAnimation { duration: 120; easing.type: Easing.OutQuad } }
            Behavior on color { ColorAnimation { duration: control.down ? SpellUI.SpellTheme.durationFast : 120; easing.type: Easing.OutQuad } }
            Behavior on scale { NumberAnimation { duration: control.down ? SpellUI.SpellTheme.durationFast : 120; easing.type: Easing.OutQuad } }
            PromptFocusRing { focused: control.activeFocus; baseRadius: SpellUI.SpellTheme.cornerRadiusSmall }
        }

        contentItem: Text {
            text: control.text
            color: control.enabled ? SpellUI.SpellTheme.textPrimary : SpellUI.SpellTheme.textSecondary
            font: control.font
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }

    component PromptRadioButton: RadioButton {
        id: control
        spacing: SpellUI.SpellTheme.spacingS
        hoverEnabled: true
        implicitHeight: 24
        leftPadding: indicator.width + spacing + 2
        rightPadding: 0
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        indicator: Rectangle {
            x: 0
            y: (control.height - height) / 2
            implicitWidth: 16
            implicitHeight: 16
            radius: 8
            color: SpellUI.SpellTheme.surface0
            border.width: 2
            border.color: control.checked ? SpellUI.SpellTheme.primary : (control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault)
            Behavior on border.color { ColorAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }

            Rectangle {
                anchors.centerIn: parent
                width: 10
                height: 10
                radius: 5
                color: SpellUI.SpellTheme.primary
                opacity: control.checked ? 1 : 0
                Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }
            }
        }

        background: Item {}
        contentItem: Text {
            text: control.text
            color: SpellUI.SpellTheme.textPrimary
            font: control.font
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignLeft
            elide: Text.ElideRight
        }
        PromptFocusRing { focused: control.activeFocus; baseRadius: SpellUI.SpellTheme.cornerRadiusSmall }
    }

    component PromptCheckBox: CheckBox {
        id: control
        spacing: SpellUI.SpellTheme.spacingS
        hoverEnabled: true
        implicitHeight: 24
        leftPadding: indicator.width + spacing + 2
        rightPadding: 0
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        opacity: enabled ? 1 : SpellUI.SpellTheme.disabledOpacity

        indicator: Rectangle {
            x: 0
            y: (control.height - height) / 2
            implicitWidth: 16
            implicitHeight: 16
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface0
            border.width: 2
            border.color: control.checked ? SpellUI.SpellTheme.primary : (control.hovered ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault)
            Behavior on border.color { ColorAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }

            Text {
                anchors.centerIn: parent
                text: "✓"
                color: SpellUI.SpellTheme.primary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeCaption
                font.weight: SpellUI.SpellTheme.fontWeightBold
                opacity: control.checked ? 1 : 0
                Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }
            }
        }

        background: Item {}
        contentItem: Text {
            text: control.text
            color: SpellUI.SpellTheme.textPrimary
            font: control.font
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignLeft
            elide: Text.ElideRight
        }
        PromptFocusRing { focused: control.activeFocus; baseRadius: SpellUI.SpellTheme.cornerRadiusSmall }
    }

    component PromptTextInput: TextField {
        id: control
        implicitHeight: 36
        leftPadding: 12
        rightPadding: 12
        font.family: SpellUI.SpellTheme.fontFamily
        font.pixelSize: SpellUI.SpellTheme.fontSizeM
        font.weight: SpellUI.SpellTheme.fontWeightRegular
        color: SpellUI.SpellTheme.textPrimary
        placeholderTextColor: SpellUI.SpellTheme.textTertiary

        background: Rectangle {
            color: SpellUI.SpellTheme.surface0
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            border.width: 1
            border.color: control.activeFocus ? SpellUI.SpellTheme.borderStrong : SpellUI.SpellTheme.borderDefault
            Behavior on border.color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast; easing.type: Easing.OutQuad } }
            PromptFocusRing { focused: control.activeFocus; baseRadius: SpellUI.SpellTheme.cornerRadiusSmall }
        }
    }

    component PromptWidget: Rectangle {
        id: pw
        required property string promptType
        required property string question
        required property var options
        property bool answered: false
        property var response: null

        implicitHeight: pwCol.implicitHeight + 32
        color: SpellUI.SpellTheme.surface1
        radius: SpellUI.SpellTheme.cornerRadius
        border.width: 1
        border.color: SpellUI.SpellTheme.borderDefault

        ColumnLayout {
            id: pwCol
            anchors { fill: parent; margins: 16 }
            spacing: SpellUI.SpellTheme.spacingS
            enabled: !pw.answered

            Text {
                text: pw.question
                color: SpellUI.SpellTheme.textPrimary
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeL
                font.weight: SpellUI.SpellTheme.fontWeightSemiBold
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }

            Loader {
                active: pw.promptType === "radio"
                Layout.fillWidth: true
                sourceComponent: Column {
                    spacing: SpellUI.SpellTheme.spacingXS
                    ButtonGroup { id: radioGroup }
                    property int hoveredOptionIndex: -1

                    Repeater {
                        model: pw.options
                        delegate: Rectangle {
                            required property string modelData
                            required property int index
                            width: parent ? parent.width : 0
                            height: radioButton.implicitHeight + 8
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            property bool selectedAfterAnswer: pw.answered && pw.response === modelData
                            property bool hovered: parent ? parent.hoveredOptionIndex === index : false
                            color: hovered ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.08) : "transparent"
                            opacity: !pw.answered || selectedAfterAnswer ? 1 : 0.5

                            Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationMedium; easing.type: Easing.OutQuad } }
                            Behavior on color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast; easing.type: Easing.OutQuad } }

                            Rectangle {
                                anchors.left: parent.left
                                anchors.top: parent.top
                                anchors.bottom: parent.bottom
                                width: selectedAfterAnswer ? 2 : 0
                                color: SpellUI.SpellTheme.success
                                Behavior on width { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }
                            }

                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                enabled: !pw.answered
                                onEntered: parent.parent.hoveredOptionIndex = index
                                onExited: if (parent.parent.hoveredOptionIndex === index) parent.parent.hoveredOptionIndex = -1
                                onClicked: radioButton.clicked()
                            }

                            PromptRadioButton {
                                id: radioButton
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.leftMargin: SpellUI.SpellTheme.spacingS
                                anchors.rightMargin: SpellUI.SpellTheme.spacingS
                                text: modelData
                                checked: pw.response === modelData
                                enabled: !pw.answered
                                ButtonGroup.group: radioGroup
                                onClicked: {
                                    pw.response = modelData
                                    pw.answered = true
                                }
                            }
                        }
                    }
                }
            }

            Loader {
                active: pw.promptType === "checkbox"
                Layout.fillWidth: true
                sourceComponent: Column {
                    id: cbCol
                    spacing: SpellUI.SpellTheme.spacingXS
                    property var selected: []
                    property int hoveredOptionIndex: -1

                    function containsValue(value) {
                        return selected.indexOf(value) >= 0
                    }

                    Repeater {
                        model: pw.options
                        delegate: Rectangle {
                            required property string modelData
                            required property int index
                            width: parent ? parent.width : 0
                            height: checkBox.implicitHeight + 8
                            radius: SpellUI.SpellTheme.cornerRadiusSmall
                            property bool isSelected: pw.answered ? (Array.isArray(pw.response) && pw.response.indexOf(modelData) >= 0) : cbCol.containsValue(modelData)
                            property bool hovered: parent ? parent.hoveredOptionIndex === index : false
                            color: hovered ? SpellUI.SpellTheme.withAlpha(SpellUI.SpellTheme.primary, 0.08) : "transparent"
                            opacity: !pw.answered || isSelected ? 1 : 0.5

                            Behavior on opacity { NumberAnimation { duration: SpellUI.SpellTheme.durationMedium; easing.type: Easing.OutQuad } }
                            Behavior on color { ColorAnimation { duration: SpellUI.SpellTheme.durationFast; easing.type: Easing.OutQuad } }

                            Rectangle {
                                anchors.left: parent.left
                                anchors.top: parent.top
                                anchors.bottom: parent.bottom
                                width: pw.answered && isSelected ? 2 : 0
                                color: SpellUI.SpellTheme.success
                                Behavior on width { NumberAnimation { duration: SpellUI.SpellTheme.durationNormal; easing.type: Easing.OutQuad } }
                            }

                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                enabled: !pw.answered
                                onEntered: parent.parent.hoveredOptionIndex = index
                                onExited: if (parent.parent.hoveredOptionIndex === index) parent.parent.hoveredOptionIndex = -1
                                onClicked: checkBox.toggle()
                            }

                            PromptCheckBox {
                                id: checkBox
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.leftMargin: SpellUI.SpellTheme.spacingS
                                anchors.rightMargin: SpellUI.SpellTheme.spacingS
                                text: modelData
                                checked: isSelected
                                enabled: !pw.answered
                                onToggled: {
                                    var sel = cbCol.selected.slice()
                                    if (checked) {
                                        if (sel.indexOf(modelData) < 0)
                                            sel.push(modelData)
                                    } else {
                                        var idx = sel.indexOf(modelData)
                                        if (idx >= 0)
                                            sel.splice(idx, 1)
                                    }
                                    cbCol.selected = sel
                                }
                            }
                        }
                    }

                    PromptButton {
                        text: "Submit"
                        enabled: cbCol.selected.length > 0 && !pw.answered
                        onClicked: {
                            pw.response = cbCol.selected
                            pw.answered = true
                        }
                    }
                }
            }

            Loader {
                active: pw.promptType === "text"
                Layout.fillWidth: true
                sourceComponent: RowLayout {
                    spacing: SpellUI.SpellTheme.spacingS

                    PromptTextInput {
                        id: promptField
                        Layout.fillWidth: true
                        placeholderText: "Type your response..."
                        enabled: !pw.answered
                        onAccepted: submitButton.clicked()
                    }

                    PromptButton {
                        id: submitButton
                        text: "Submit"
                        enabled: !pw.answered && promptField.text.length > 0
                        onClicked: {
                            if (promptField.text.length > 0) {
                                pw.response = promptField.text
                                pw.answered = true
                            }
                        }
                    }
                }
            }

            Text {
                visible: pw.answered
                text: "Answered"
                color: SpellUI.SpellTheme.success
                font.family: SpellUI.SpellTheme.fontFamily
                font.pixelSize: SpellUI.SpellTheme.fontSizeS
                font.weight: SpellUI.SpellTheme.fontWeightMedium
            }
        }
    }
}