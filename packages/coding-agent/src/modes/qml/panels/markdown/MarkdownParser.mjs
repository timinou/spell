// MarkdownParser.mjs — Pure JS markdown-to-segments parser for QML.
// No QML imports. Testable from TS via evaluate().
//
// Output: Array of { type: "rich"|"code"|"hr", html?, content?, lang? }
// Design: stateless, re-invoked on every text change. Unclosed code fences
// are treated as open code blocks (streaming-friendly).

function markdownToSegments(text) {
    if (!text || text.length === 0) return []

    var lines = text.split("\n")
    var segments = []
    var richLines = []
    var inCode = false
    var codeLang = ""
    var codeLines = []

    function flushRich() {
        if (richLines.length === 0) return
        var html = richLinesToHtml(richLines)
        if (html.length > 0) {
            segments.push({ type: "rich", html: html })
        }
        richLines = []
    }

    function flushCode() {
        segments.push({
            type: "code",
            lang: codeLang,
            content: codeLines.join("\n")
        })
        codeLines = []
        codeLang = ""
    }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]

        if (inCode) {
            if (/^```\s*$/.test(line)) {
                flushCode()
                inCode = false
            } else {
                codeLines.push(line)
            }
            continue
        }

        // Fenced code block start
        var fenceMatch = line.match(/^```(\w*)/)
        if (fenceMatch) {
            flushRich()
            inCode = true
            codeLang = fenceMatch[1] || ""
            continue
        }

        // Horizontal rule
        if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) {
            flushRich()
            segments.push({ type: "hr" })
            continue
        }

        richLines.push(line)
    }

    // Unclosed code fence — treat as open code block (streaming)
    if (inCode) {
        flushCode()
    } else {
        flushRich()
    }

    return segments
}

function richLinesToHtml(lines) {
    var htmlLines = []

    var inUl = false
    var inOl = false

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]

        // Headers
        var headerMatch = line.match(/^(#{1,3})\s+(.*)/)
        if (headerMatch) {
            closeLists()
            var level = headerMatch[1].length
            var sizes = { 1: "24", 2: "20", 3: "17" }
            var size = sizes[level] || "17"
            htmlLines.push("<span style=\"font-size:" + size + "px;font-weight:bold;\">" + inlineFormat(headerMatch[2]) + "</span>")
            continue
        }

        // Unordered list
        var ulMatch = line.match(/^[-*+]\s+(.*)/)
        if (ulMatch) {
            if (inOl) { htmlLines.push("</ol>"); inOl = false }
            if (!inUl) { htmlLines.push("<ul>"); inUl = true }
            htmlLines.push("<li>" + inlineFormat(ulMatch[1]) + "</li>")
            continue
        }

        // Ordered list
        var olMatch = line.match(/^\d+\.\s+(.*)/)
        if (olMatch) {
            if (inUl) { htmlLines.push("</ul>"); inUl = false }
            if (!inOl) { htmlLines.push("<ol>"); inOl = true }
            htmlLines.push("<li>" + inlineFormat(olMatch[1]) + "</li>")
            continue
        }

        closeLists()

        // Empty line → paragraph break
        if (line.trim().length === 0) {
            htmlLines.push("<br>")
            continue
        }

        htmlLines.push(inlineFormat(line))
        // Add line break between non-empty lines unless last
        if (i < lines.length - 1 && lines[i + 1].trim().length > 0) {
            htmlLines.push("<br>")
        }
    }

    closeLists()
    return htmlLines.join("")

    function closeLists() {
        if (inUl) { htmlLines.push("</ul>"); inUl = false }
        if (inOl) { htmlLines.push("</ol>"); inOl = false }
    }
}

function inlineFormat(text) {
    // Escape HTML entities first
    text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    text = text.replace(/__(.+?)__/g, "<b>$1</b>")

    // Italic: *text* or _text_ (not inside bold)
    text = text.replace(/\*(.+?)\*/g, "<i>$1</i>")
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>")

    // Inline code: `text`
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>")

    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>")

    return text
}
