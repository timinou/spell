import { renderMermaidASCII } from "beautiful-mermaid";
export function renderMermaidAscii(source, options) {
    return renderMermaidASCII(source, options);
}
export function renderMermaidAsciiSafe(source, options) {
    try {
        return renderMermaidASCII(source, options);
    }
    catch {
        return null;
    }
}
/**
 * Extract mermaid code blocks from markdown text.
 */
export function extractMermaidBlocks(markdown) {
    const blocks = [];
    const regex = /```mermaid\s*\n([\s\S]*?)```/g;
    for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
        const source = match[1].trim();
        const hash = Bun.hash.xxHash64(source);
        blocks.push({ source, hash });
    }
    return blocks;
}
//# sourceMappingURL=mermaid-ascii.js.map