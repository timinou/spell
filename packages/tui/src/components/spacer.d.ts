import type { Component, DirtyParent } from "../tui";
/**
 * Spacer component that renders empty lines
 */
export declare class Spacer implements Component {
    #private;
    constructor(lines?: number);
    setParent(p: DirtyParent | undefined): void;
    setLines(lines: number): void;
    invalidate(): void;
    render(_width: number): string[];
}
//# sourceMappingURL=spacer.d.ts.map