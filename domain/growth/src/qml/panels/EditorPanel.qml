import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import SpellBridge.Native 1.0
import "../components"
import "../../../../../packages/coding-agent/src/modes/qml" as ShellTheme

Item {
    id: editorPanel

    property string currentPath: "templates/weekly-digest.typ"
    property bool fileTreeVisible: true
    property bool sourceModeVisible: false
    property bool forceDegradedPreview: false
    property bool agentBusy: false
    property bool dismissRecoveryHint: false
    property string currentTemplateId: "weekly-digest"
    property string documentSource: ""
    property string manualSource: ""
    property string selectedAnchor: ""
    property int draftCounter: 0
    property var lastHit: ({ kind: "outside-document" })
    property var templates: [
        { id: "weekly-digest", name: "Weekly Digest", description: "Executive update with metrics and hero image.", path: "templates/weekly-digest.typ" },
        { id: "launch-brief", name: "Launch Brief", description: "Product launch memo with action bullets.", path: "templates/launch-brief.typ" },
        { id: "performance-review", name: "Performance Review", description: "Table-heavy recap with a configurable title.", path: "templates/performance-review.typ" }
    ]
    property var files: [
        { path: "templates/weekly-digest.typ", name: "weekly-digest.typ", dir: "templates" },
        { path: "templates/launch-brief.typ", name: "launch-brief.typ", dir: "templates" },
        { path: "reports/performance-review.typ", name: "performance-review.typ", dir: "reports" }
    ]
    property var assets: [
        { label: "Brand hero", path: "assets/hero.png" },
        { label: "Executive cover", path: "assets/executive-cover.png" },
        { label: "Quarterly chart", path: "assets/chart-q2.png" }
    ]
    property var documentBlocks: []
    property var selectedBlock: findBlock(selectedAnchor)

    function cloneValue(value) {
        return JSON.parse(JSON.stringify(value))
    }

    function createBaseBlocks() {
        return [
            { anchor: "var-title", kind: "variable", text: 'report_title = "Weekly Digest"', meta: { name: "report_title", value: '"Weekly Digest"' }, editable: true },
            { anchor: "heading-summary", kind: "heading", text: "Executive Summary", level: 1, meta: {}, editable: true },
            { anchor: "paragraph-overview", kind: "paragraph", text: "This week the team shipped the native Typst surface and contextual editing shell.", meta: {}, editable: true },
            { anchor: "list-highlights-1", kind: "list_item", text: "Highlight the summary with a single click.", meta: {}, editable: true },
            { anchor: "list-highlights-2", kind: "list_item", text: "Swap assets and variables without exposing raw Typst.", meta: {}, editable: true },
            { anchor: "image-hero", kind: "image", text: "assets/hero.png", meta: { path: "assets/hero.png" }, editable: true },
            { anchor: "table-metrics", kind: "table", text: "", meta: { rows: [["Metric", "Value"], ["CTR", "4.2%"], ["ROAS", "3.8x"]] }, editable: true },
            { anchor: "paragraph-close", kind: "paragraph", text: "Use the hidden recovery view only when the document enters preview-only or recovery mode.", meta: {}, editable: true }
        ]
    }

    function createLaunchBlocks() {
        return [
            { anchor: "var-title", kind: "variable", text: 'launch_name = "Spring Release"', meta: { name: "launch_name", value: '"Spring Release"' }, editable: true },
            { anchor: "heading-summary", kind: "heading", text: "Launch Brief", level: 1, meta: {}, editable: true },
            { anchor: "paragraph-overview", kind: "paragraph", text: "Summarize positioning, timing, and the primary user benefit here.", meta: {}, editable: true },
            { anchor: "list-highlights-1", kind: "list_item", text: "Audience: existing enterprise customers.", meta: {}, editable: true },
            { anchor: "list-highlights-2", kind: "list_item", text: "CTA: book rollout training.", meta: {}, editable: true },
            { anchor: "image-hero", kind: "image", text: "assets/executive-cover.png", meta: { path: "assets/executive-cover.png" }, editable: true },
            { anchor: "paragraph-close", kind: "paragraph", text: "Capture risks and mitigations in the contextual sidebar.", meta: {}, editable: true }
        ]
    }

    function createPerformanceBlocks() {
        return [
            { anchor: "var-title", kind: "variable", text: 'report_title = "Performance Review"', meta: { name: "report_title", value: '"Performance Review"' }, editable: true },
            { anchor: "heading-summary", kind: "heading", text: "Performance Review", level: 1, meta: {}, editable: true },
            { anchor: "table-metrics", kind: "table", text: "", meta: { rows: [["Campaign", "Spend", "ROAS"], ["Retargeting", "$4,200", "5.1x"], ["Prospecting", "$8,900", "2.9x"]] }, editable: true },
            { anchor: "paragraph-close", kind: "paragraph", text: "Adjust rows directly from the table controls and export the same canonical source.", meta: {}, editable: true }
        ]
    }

    function templateBlocks(templateId) {
        if (templateId === "launch-brief")
            return createLaunchBlocks()
        if (templateId === "performance-review")
            return createPerformanceBlocks()
        return createBaseBlocks()
    }

    function currentAssetPath() {
        if (!selectedBlock || selectedBlock.kind !== "image" || !selectedBlock.meta)
            return ""
        return selectedBlock.meta.path || ""
    }

    function serializeBlock(block) {
        if (block.kind === "heading")
            return ["=".repeat(block.level || 1) + " " + block.text]
        if (block.kind === "paragraph")
            return [block.text]
        if (block.kind === "list_item")
            return ["- " + block.text]
        if (block.kind === "image")
            return ['#image("' + ((block.meta && block.meta.path) ? block.meta.path : block.text) + '")']
        if (block.kind === "table") {
            const rows = block.meta && block.meta.rows ? block.meta.rows : []
            return rows.map(function(row) { return "| " + row.join(" | ") + " |" })
        }
        if (block.kind === "variable") {
            const name = block.meta && block.meta.name ? block.meta.name : "variable"
            const value = block.meta && block.meta.value ? block.meta.value : '""'
            return ["#let " + name + " = " + value]
        }
        if (block.kind === "unsupported")
            return block.rawLines || [block.text]
        return [block.text]
    }

    function needsBlankLine(previousKind, nextKind) {
        if (!previousKind)
            return false
        if (previousKind === "list_item" && nextKind === "list_item")
            return false
        if (previousKind === "table" && nextKind === "table")
            return false
        if (previousKind === "variable" && nextKind === "variable")
            return false
        return true
    }

    function serializeDocument(blocks) {
        const lines = []
        let previousKind = ""
        for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index]
            const rendered = serializeBlock(block)
            if (rendered.length === 0)
                continue
            if (lines.length > 0 && needsBlankLine(previousKind, block.kind))
                lines.push("")
            for (let lineIndex = 0; lineIndex < rendered.length; lineIndex += 1)
                lines.push(rendered[lineIndex])
            previousKind = block.kind
        }
        return lines.join("\n")
    }

    function emitStateChange() {
        if (typeof bridge !== "undefined") {
            bridge.send({
                type: "editor_state_changed",
                source: documentSource,
                selectedAnchor: selectedAnchor,
                capability: documentSurface.capability
            })
        }
    }

    function refreshDocumentSource() {
        documentSource = serializeDocument(documentBlocks)
        manualSource = documentSource
        emitStateChange()
    }

    function resetToTemplate(templateId) {
        currentTemplateId = templateId
        documentBlocks = cloneValue(templateBlocks(templateId))
        currentPath = templates.find(function(template) { return template.id === templateId }).path
        selectedAnchor = documentBlocks.length > 0 ? documentBlocks[0].anchor : ""
        lastHit = ({ kind: "outside-document" })
        dismissRecoveryHint = false
        refreshDocumentSource()
    }

    function findBlock(anchor) {
        for (let index = 0; index < documentBlocks.length; index += 1) {
            if (documentBlocks[index].anchor === anchor)
                return documentBlocks[index]
        }
        return null
    }

    function selectedIndex() {
        for (let index = 0; index < documentBlocks.length; index += 1) {
            if (documentBlocks[index].anchor === selectedAnchor)
                return index
        }
        return -1
    }

    function applySelectedKind(kind, level) {
        const index = selectedIndex()
        if (index < 0)
            return
        documentBlocks[index].kind = kind
        if (kind === "heading")
            documentBlocks[index].level = level || 1
        else
            delete documentBlocks[index].level
        refreshDocumentSource()
    }

    function updateSelectedText(text) {
        const index = selectedIndex()
        if (index < 0)
            return
        documentBlocks[index].text = text
        refreshDocumentSource()
    }

    function replaceSelectedAsset(path) {
        const index = selectedIndex()
        if (index < 0)
            return
        documentBlocks[index].kind = "image"
        documentBlocks[index].text = path
        documentBlocks[index].meta = { path: path }
        refreshDocumentSource()
    }

    function updateSelectedVariable(name, value) {
        const index = selectedIndex()
        if (index < 0)
            return
        documentBlocks[index].kind = "variable"
        documentBlocks[index].text = name + " = " + value
        documentBlocks[index].meta = { name: name, value: value }
        refreshDocumentSource()
    }

    function updateTableCell(row, column, value) {
        const index = selectedIndex()
        if (index < 0 || documentBlocks[index].kind !== "table")
            return
        const rows = cloneValue(documentBlocks[index].meta.rows || [])
        while (rows.length <= row)
            rows.push([])
        while (rows[row].length <= column)
            rows[row].push("")
        rows[row][column] = value
        documentBlocks[index].meta = { rows: rows }
        refreshDocumentSource()
    }

    function agentRewriteSelection() {
        const index = selectedIndex()
        if (index < 0)
            return
        if (documentBlocks[index].kind === "image") {
            replaceSelectedAsset("assets/chart-q2.png")
            return
        }
        documentBlocks[index].text = "Agent rewrite: " + documentBlocks[index].text
        refreshDocumentSource()
    }

    function agentInsertSection() {
        const blocks = cloneValue(documentBlocks)
        const index = selectedIndex()
        const insertionIndex = index >= 0 ? index + 1 : blocks.length
        draftCounter += 1
        const heading = { anchor: "draft-" + draftCounter, kind: "heading", text: "Agent Summary", level: 2, meta: {}, editable: true }
        draftCounter += 1
        const paragraph = { anchor: "draft-" + draftCounter, kind: "paragraph", text: "Agent inserted this supporting section through the same canonical document pipeline.", meta: {}, editable: true }
        blocks.splice(insertionIndex, 0, heading, paragraph)
        documentBlocks = blocks
        selectedAnchor = heading.anchor
        refreshDocumentSource()
    }

    function createBlock(kind) {
        draftCounter += 1
        if (kind === "image")
            return { anchor: "draft-" + draftCounter, kind: kind, text: "assets/hero.png", meta: { path: "assets/hero.png" }, editable: true }
        if (kind === "heading")
            return { anchor: "draft-" + draftCounter, kind: kind, text: "New heading", level: 2, meta: {}, editable: true }
        if (kind === "list_item")
            return { anchor: "draft-" + draftCounter, kind: kind, text: "New list item", meta: {}, editable: true }
        return { anchor: "draft-" + draftCounter, kind: "paragraph", text: "New paragraph", meta: {}, editable: true }
    }

    function insertBlock(kind) {
        const blocks = cloneValue(documentBlocks)
        const index = selectedIndex()
        const insertionIndex = index >= 0 ? index + 1 : blocks.length
        const block = createBlock(kind)
        blocks.splice(insertionIndex, 0, block)
        documentBlocks = blocks
        selectedAnchor = block.anchor
        refreshDocumentSource()
    }

    function moveSelected(direction) {
        const blocks = cloneValue(documentBlocks)
        const index = selectedIndex()
        if (index < 0)
            return
        const targetIndex = direction === "up" ? index - 1 : index + 1
        if (targetIndex < 0 || targetIndex >= blocks.length)
            return
        const temporary = blocks[index]
        blocks[index] = blocks[targetIndex]
        blocks[targetIndex] = temporary
        documentBlocks = blocks
        refreshDocumentSource()
    }

    function deleteSelected() {
        const blocks = cloneValue(documentBlocks)
        const index = selectedIndex()
        if (index < 0)
            return
        blocks.splice(index, 1)
        documentBlocks = blocks
        selectedAnchor = blocks.length > 0 ? blocks[Math.max(0, index - 1)].anchor : ""
        refreshDocumentSource()
    }

    function openRecoverySource() {
        sourceModeVisible = true
        manualSource = documentSource
    }

    function applyRecoverySource() {
        documentSource = manualSource
        sourceModeVisible = false
        emitStateChange()
    }

    function templateForComponent(componentType) {
        if (componentType === "table")
            return "table"
        if (componentType === "text-block")
            return "paragraph"
        if (componentType === "section-header")
            return "heading"
        return "paragraph"
    }

    Rectangle {
        anchors.fill: parent
        color: ShellTheme.SpellTheme.background

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: ShellTheme.SpellTheme.spacingL
            spacing: ShellTheme.SpellTheme.spacingL

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 58
                radius: ShellTheme.SpellTheme.cornerRadiusLarge
                color: ShellTheme.SpellTheme.surface0
                border.width: 1
                border.color: ShellTheme.SpellTheme.borderDefault

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: ShellTheme.SpellTheme.spacingM
                    spacing: ShellTheme.SpellTheme.spacingS

                    ToolButton {
                        text: fileTreeVisible ? "Hide files" : "Show files"
                        onClicked: fileTreeVisible = !fileTreeVisible
                    }

                    Text {
                        Layout.fillWidth: true
                        text: currentPath
                        color: ShellTheme.SpellTheme.textPrimary
                        font.pixelSize: ShellTheme.SpellTheme.fontSizeM
                        font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
                        elide: Text.ElideLeft
                    }

                    BlockControls {
                        currentKind: selectedBlock ? selectedBlock.kind : "paragraph"
                        currentLevel: selectedBlock && selectedBlock.level ? selectedBlock.level : 1
                        onBlockKindSelected: function(kind, level) {
                            applySelectedKind(kind, level)
                        }
                    }

                    Button {
                        text: "Insert"
                        onClicked: insertMenu.open()
                    }

                    Button {
                        text: "Templates"
                        onClicked: templateDrawer.open()
                    }

                    Button {
                        text: sourceModeVisible ? "Visual mode" : "Recovery source"
                        onClicked: {
                            if (sourceModeVisible)
                                sourceModeVisible = false
                            else
                                openRecoverySource()
                        }
                    }
                }
            }

            SplitView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                orientation: Qt.Horizontal

                Rectangle {
                    visible: fileTreeVisible
                    color: "transparent"
                    SplitView.preferredWidth: 250
                    SplitView.minimumWidth: 220

                    ColumnLayout {
                        anchors.fill: parent
                        spacing: ShellTheme.SpellTheme.spacingL

                        TypstFileTree {
                            id: fileTree
                            Layout.fillWidth: true
                            Layout.preferredHeight: 220
                            files: editorPanel.files
                            selectedPath: currentPath
                            onFileSelected: function(filePath) {
                                currentPath = filePath
                            }
                        }

                        ComponentPalette {
                            id: componentPalette
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            onComponentPicked: function(componentType) {
                                insertBlock(templateForComponent(componentType))
                            }
                        }
                    }
                }

                Rectangle {
                    SplitView.fillWidth: true
                    color: "transparent"
                    radius: ShellTheme.SpellTheme.cornerRadiusLarge

                    ColumnLayout {
                        anchors.fill: parent
                        spacing: ShellTheme.SpellTheme.spacingM

                        FallbackStatusBanner {
                            id: previewBanner
                            objectName: "previewOnlyBanner"
                            Layout.fillWidth: true
                            visible: documentSurface.capability === "preview_only"
                            title: "Preview-only mode"
                            message: documentSurface.statusMessage
                            actionText: "Open recovery"
                            onActionTriggered: openRecoverySource()
                        }

                        RecoveryBanner {
                            id: recoveryBanner
                            objectName: "recoveryBanner"
                            Layout.fillWidth: true
                            visible: !dismissRecoveryHint && (documentSurface.capability === "recovery_only" || (documentSurface.capability === "mixed" && lastHit.kind === "noneditable-preview"))
                            message: documentSurface.capability === "recovery_only"
                                ? documentSurface.statusMessage
                                : "The selected visual region is intentionally preview-only. Switch to recovery mode to edit unsupported syntax truthfully."
                            onOpenRecoveryRequested: openRecoverySource()
                            onDismissRequested: dismissRecoveryHint = true
                        }

                        Rectangle {
                            id: surfaceShell
                            objectName: "editorSurfaceShell"
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            radius: ShellTheme.SpellTheme.cornerRadiusLarge
                            color: ShellTheme.SpellTheme.surface0
                            border.width: 1
                            border.color: ShellTheme.SpellTheme.borderDefault

                            Item {
                                anchors.fill: parent

                                TypstDocumentItem {
                                    id: documentSurface
                                    objectName: "typstDocumentSurface"
                                    anchors.fill: parent
                                    anchors.margins: ShellTheme.SpellTheme.spacingL
                                    visible: !sourceModeVisible
                                    source: editorPanel.documentSource
                                    forceDegraded: editorPanel.forceDegradedPreview
                                    onHitResolved: function(hit) {
                                        lastHit = hit
                                        if ((hit.kind === "editable-span" || hit.kind === "noneditable-preview") && hit.anchor)
                                            selectedAnchor = hit.anchor
                                    }
                                }

                                Rectangle {
                                    anchors.fill: parent
                                    visible: sourceModeVisible
                                    color: ShellTheme.SpellTheme.surface0

                                    ColumnLayout {
                                        anchors.fill: parent
                                        anchors.margins: ShellTheme.SpellTheme.spacingL
                                        spacing: ShellTheme.SpellTheme.spacingM

                                        Text {
                                            text: "Hidden recovery source mode"
                                            color: ShellTheme.SpellTheme.textPrimary
                                            font.pixelSize: ShellTheme.SpellTheme.fontSizeL
                                            font.weight: ShellTheme.SpellTheme.fontWeightSemiBold
                                        }

                                        Text {
                                            Layout.fillWidth: true
                                            text: "Use this only for unsupported constructs, syntax recovery, or agent refresh conflicts."
                                            color: ShellTheme.SpellTheme.textSecondary
                                            wrapMode: Text.WordWrap
                                        }

                                        TextArea {
                                            id: sourceEditor
                                            objectName: "recoverySourceEditor"
                                            Layout.fillWidth: true
                                            Layout.fillHeight: true
                                            text: manualSource
                                            wrapMode: TextArea.NoWrap
                                            color: ShellTheme.SpellTheme.textPrimary
                                            font.family: ShellTheme.SpellTheme.monoFontFamily
                                            selectByMouse: true
                                        }

                                        RowLayout {
                                            Layout.fillWidth: true

                                            Button {
                                                text: "Apply source"
                                                onClicked: {
                                                    manualSource = sourceEditor.text
                                                    applyRecoverySource()
                                                }
                                            }

                                            Button {
                                                text: "Return to visual surface"
                                                onClicked: sourceModeVisible = false
                                            }
                                        }
                                    }
                                }

                                Rectangle {
                                    anchors.right: parent.right
                                    anchors.bottom: parent.bottom
                                    anchors.margins: ShellTheme.SpellTheme.spacingM
                                    radius: 999
                                    color: documentSurface.capability === "interactive"
                                        ? Qt.rgba(ShellTheme.SpellTheme.success.r, ShellTheme.SpellTheme.success.g, ShellTheme.SpellTheme.success.b, 0.16)
                                        : Qt.rgba(ShellTheme.SpellTheme.warning.r, ShellTheme.SpellTheme.warning.g, ShellTheme.SpellTheme.warning.b, 0.16)
                                    border.width: 1
                                    border.color: documentSurface.capability === "interactive"
                                        ? ShellTheme.SpellTheme.success
                                        : ShellTheme.SpellTheme.warning
                                    implicitHeight: 30
                                    implicitWidth: badgeText.implicitWidth + 24

                                    Text {
                                        id: badgeText
                                        anchors.centerIn: parent
                                        text: documentSurface.capability.replace("_", " ")
                                        color: documentSurface.capability === "interactive"
                                            ? ShellTheme.SpellTheme.success
                                            : ShellTheme.SpellTheme.warning
                                        font.pixelSize: ShellTheme.SpellTheme.fontSizeXS
                                        font.weight: ShellTheme.SpellTheme.fontWeightMedium
                                    }
                                }
                            }
                        }
                    }
                }

                ContextualSidebar {
                    id: contextualSidebar
                    objectName: "contextualSidebar"
                    SplitView.preferredWidth: 340
                    SplitView.minimumWidth: 300
                    Layout.fillHeight: true
                    block: selectedBlock
                    busy: agentBusy
                    capability: documentSurface.capability
                    unsupportedReason: lastHit.kind === "noneditable-preview" ? lastHit.reason : ""
                    onBlockTextEdited: function(text) {
                        updateSelectedText(text)
                    }
                    onBlockKindRequested: function(kind, level) {
                        applySelectedKind(kind, level)
                    }
                    onAssetPickerRequested: assetDrawer.open()
                    onVariableEdited: function(name, value) {
                        updateSelectedVariable(name, value)
                    }
                    onTableCellEdited: function(row, column, value) {
                        updateTableCell(row, column, value)
                    }
                    onMoveRequested: function(direction) {
                        moveSelected(direction)
                    }
                    onDeleteRequested: deleteSelected()
                    onRecoveryRequested: openRecoverySource()
                    onAgentRewriteRequested: agentRewriteSelection()
                    onAgentInsertRequested: agentInsertSection()
                }
            }
        }
    }

    InsertMenu {
        id: insertMenu
        objectName: "insertMenu"
        x: Math.max(24, editorPanel.width - width - 40)
        y: 72
        onInsertRequested: function(kind) {
            insertBlock(kind)
        }
    }

    Drawer {
        id: templateDrawer
        objectName: "templateDrawer"
        parent: editorPanel.Window.window ? editorPanel.Window.window.contentItem : editorPanel
        width: 320
        height: parent.height
        edge: Qt.LeftEdge
        background: Rectangle { color: ShellTheme.SpellTheme.surface0 }

        TemplateSelector {
            anchors.fill: parent
            templates: editorPanel.templates
            onTemplateSelected: function(templateId, templatePath) {
                currentPath = templatePath
                resetToTemplate(templateId)
                templateDrawer.close()
            }
        }
    }

    AssetPickerDrawer {
        id: assetDrawer
        objectName: "assetPickerDrawer"
        parent: editorPanel.Window.window ? editorPanel.Window.window.contentItem : editorPanel
        height: editorPanel.height
        assets: editorPanel.assets
        currentPath: currentAssetPath()
        onAssetPicked: function(path) {
            replaceSelectedAsset(path)
        }
    }

    Connections {
        target: typeof bridge !== "undefined" ? bridge : null

        function onMessageReceived(payload) {
            if (payload.type === "reset") {
                forceDegradedPreview = false
                sourceModeVisible = false
                agentBusy = false
                dismissRecoveryHint = false
                resetToTemplate("weekly-digest")
                bridge.send({ type: "reset_done" })
            }

            if (payload.type === "set_force_degraded")
                forceDegradedPreview = Boolean(payload.value)

            if (payload.type === "open_template_drawer")
                templateDrawer.open()

            if (payload.type === "open_asset_drawer")
                assetDrawer.open()

            if (payload.type === "set_source") {
                if (payload.blocks) {
                    documentBlocks = cloneValue(payload.blocks)
                    selectedAnchor = payload.selectedAnchor || (documentBlocks.length > 0 ? documentBlocks[0].anchor : "")
                    refreshDocumentSource()
                } else if (payload.source) {
                    documentSource = payload.source
                    manualSource = payload.source
                }
            }

            if (payload.type === "set_activity")
                agentBusy = Boolean(payload.busy)

            if (payload.type === "open_recovery")
                openRecoverySource()

            if (payload.type === "set_last_hit")
                lastHit = payload.hit || lastHit

            if (payload.type === "query") {
                bridge.send({
                    type: "query_response",
                    query: payload.query,
                    result: {
                        capability: documentSurface.capability,
                        sourceModeVisible: sourceModeVisible,
                        selectedAnchor: selectedAnchor,
                        selectedKind: selectedBlock ? selectedBlock.kind : "",
                        currentTemplateId: currentTemplateId,
                        previewBannerVisible: previewBanner.visible,
                        recoveryBannerVisible: recoveryBanner.visible,
                        assetDrawerOpen: assetDrawer.opened || assetDrawer.visible,
                        templateDrawerOpen: templateDrawer.opened || templateDrawer.visible,
                        insertMenuOpen: insertMenu.opened,
                        currentPath: currentPath,
                        documentSource: documentSource,
                        lastHitKind: lastHit.kind
                    }
                })
            }
        }
    }

    Component.onCompleted: {
        resetToTemplate(currentTemplateId)
        if (typeof bridge !== "undefined")
            bridge.send({ type: "panel_ready", panelId: "editor" })
    }
}