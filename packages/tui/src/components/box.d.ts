import type { Component } from "../tui";
/**
 * Box component - a container that applies padding and background to all children
 */
export declare class Box implements Component {
    #private;
    children: Component[];
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    setBgFn(bgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=box.d.ts.map