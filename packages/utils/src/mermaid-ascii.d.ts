import { type AsciiRenderOptions } from "beautiful-mermaid";
export type { AsciiRenderOptions as MermaidAsciiRenderOptions };
export declare function renderMermaidAscii(source: string, options?: AsciiRenderOptions): string;
export declare function renderMermaidAsciiSafe(source: string, options?: AsciiRenderOptions): string | null;
/**
 * Extract mermaid code blocks from markdown text.
 */
export declare function extractMermaidBlocks(markdown: string): {
    source: string;
    hash: bigint;
}[];
//# sourceMappingURL=mermaid-ascii.d.ts.map