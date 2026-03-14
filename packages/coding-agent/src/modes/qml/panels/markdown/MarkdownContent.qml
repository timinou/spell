import QtQuick 2.15
import QtQuick.Layouts 1.15
import "../.." as SpellUI

Item {
    id: root
    objectName: "markdownContent"
    required property string text
    required property bool isStreaming

    signal linkActivated(string link)
    signal codeSaveRequested(string content, string lang)

    width: parent ? parent.width : 0
    height: contentColumn.height

    property var segments: []

    onTextChanged: {
        segments = parseMarkdown(text)
    }

    // --- Inline markdown parser ---

    function parseMarkdown(text) {
        if (!text || text.length === 0) return []

        var lines = text.split("\n")
        var segs = []
        var richLines = []
        var inCode = false
        var codeLang = ""
        var codeLines = []

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i]

            if (inCode) {
                if (/^```\s*$/.test(line)) {
                    segs.push({ type: "code", lang: codeLang, content: codeLines.join("\n") })
                    codeLines = []
                    codeLang = ""
                    inCode = false
                } else {
                    codeLines.push(line)
                }
                continue
            }

            var fenceMatch = line.match(/^```(\w*)/)
            if (fenceMatch) {
                flushRich(richLines, segs)
                richLines = []
                inCode = true
                codeLang = fenceMatch[1] || ""
                continue
            }

            if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) {
                flushRich(richLines, segs)
                richLines = []
                segs.push({ type: "hr" })
                continue
            }

            richLines.push(line)
        }

        if (inCode) {
            segs.push({ type: "code", lang: codeLang, content: codeLines.join("\n") })
        } else {
            flushRich(richLines, segs)
        }

        return segs
    }

    function flushRich(lines, segs) {
        if (lines.length === 0) return
        var html = richLinesToHtml(lines)
        if (html.length > 0) {
            segs.push({ type: "rich", html: html })
        }
    }

    function richLinesToHtml(lines) {
        var parts = []
        var inUl = false
        var inOl = false

        function closeLists() {
            if (inUl) { parts.push("</ul>"); inUl = false }
            if (inOl) { parts.push("</ol>"); inOl = false }
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i]

            var headerMatch = line.match(/^(#{1,3})\s+(.*)/)
            if (headerMatch) {
                closeLists()
                var level = headerMatch[1].length
                var sizes = { 1: "24", 2: "20", 3: "17" }
                var sz = sizes[level] || "17"
                parts.push("<span style=\"font-size:" + sz + "px;font-weight:bold;\">" + inlineFormat(headerMatch[2]) + "</span>")
                continue
            }

            var ulMatch = line.match(/^[-*+]\s+(.*)/)
            if (ulMatch) {
                if (inOl) { parts.push("</ol>"); inOl = false }
                if (!inUl) { parts.push("<ul>"); inUl = true }
                parts.push("<li>" + inlineFormat(ulMatch[1]) + "</li>")
                continue
            }

            var olMatch = line.match(/^\d+\.\s+(.*)/)
            if (olMatch) {
                if (inUl) { parts.push("</ul>"); inUl = false }
                if (!inOl) { parts.push("<ol>"); inOl = true }
                parts.push("<li>" + inlineFormat(olMatch[1]) + "</li>")
                continue
            }

            closeLists()

            if (line.trim().length === 0) {
                parts.push("<br>")
                continue
            }

            parts.push(inlineFormat(line))
            if (i < lines.length - 1 && lines[i + 1].trim().length > 0) {
                parts.push("<br>")
            }
        }

        closeLists()
        return parts.join("")
    }

    function inlineFormat(text) {
        text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        text = text.replace(/__(.+?)__/g, "<b>$1</b>")
        text = text.replace(/\*(.+?)\*/g, "<i>$1</i>")
        text = text.replace(/`([^`]+)`/g, "<code>$1</code>")
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>")
        return text
    }

    // --- Visual rendering ---

    Column {
        id: contentColumn
        width: parent.width
        spacing: SpellUI.SpellTheme.spacingS

        Repeater {
            model: root.segments.length

            Loader {
                width: contentColumn.width
                property var segment: root.segments[index]

                sourceComponent: {
                    if (!segment) return richComponent
                    if (segment.type === "code") return codeComponent
                    if (segment.type === "hr") return hrComponent
                    return richComponent
                }
            }
        }
    }

    Component {
        id: richComponent

        Text {
            width: parent ? parent.width : 0
            text: parent && parent.segment ? parent.segment.html || "" : ""
            font.family: SpellUI.SpellTheme.fontFamily
            font.pixelSize: SpellUI.SpellTheme.fontSizeMedium
            color: SpellUI.SpellTheme.textPrimary
            wrapMode: Text.Wrap
            textFormat: Text.RichText
            onLinkActivated: function(link) { root.linkActivated(link) }
        }
    }

    Component {
        id: codeComponent

        CodeBlock {
            width: parent ? parent.width : 0
            content: parent && parent.segment ? parent.segment.content || "" : ""
            lang: parent && parent.segment ? parent.segment.lang || "" : ""
            onSaveRequested: function(content, lang) { root.codeSaveRequested(content, lang) }
        }
    }

    Component {
        id: hrComponent

        Rectangle {
            width: parent ? parent.width : 0
            height: 1
            color: SpellUI.SpellTheme.outline
        }
    }
}
