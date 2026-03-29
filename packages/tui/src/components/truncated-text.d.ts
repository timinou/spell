import type { Component } from "../tui";
/**
 * Text component that truncates to fit viewport width
 */
export declare class TruncatedText implements Component {
    #private;
    constructor(text: string, paddingX?: number, paddingY?: number);
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=truncated-text.d.ts.map