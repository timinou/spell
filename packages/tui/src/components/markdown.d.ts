import type { SymbolTheme } from "../symbols";
import type { Component } from "../tui";
/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
    /** Foreground color function */
    color?: (text: string) => string;
    /** Background color function */
    bgColor?: (text: string) => string;
    /** Bold text */
    bold?: boolean;
    /** Italic text */
    italic?: boolean;
    /** Strikethrough text */
    strikethrough?: boolean;
    /** Underline text */
    underline?: boolean;
}
/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    code: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    strikethrough: (text: string) => string;
    underline: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
    /**
     * Lookup a pre-rendered mermaid ASCII rendering by source hash.
     * Hash is computed as `Bun.hash.xxHash64(source.trim())`.
     * Return null to fall back to fenced code rendering.
     */
    getMermaidAscii?: (sourceHash: bigint) => string | null;
    symbols: SymbolTheme;
}
export declare class Markdown implements Component {
    #private;
    constructor(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme, defaultTextStyle?: DefaultTextStyle, codeBlockIndent?: number);
    setText(text: string): void;
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=markdown.d.ts.map