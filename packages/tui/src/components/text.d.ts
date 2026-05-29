import type { Component, DirtyParent } from "../tui";
/**
 * Text component - displays multi-line text with word wrapping
 */
export declare class Text implements Component {
    #private;
    setParent(p: DirtyParent | undefined): void;
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
    getText(): string;
    setText(text: string): void;
    setCustomBgFn(customBgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=text.d.ts.map