import { type ImageDimensions } from "../terminal-capabilities";
import type { Component } from "../tui";
export interface ImageTheme {
    fallbackColor: (str: string) => string;
}
export interface ImageOptions {
    maxWidthCells?: number;
    maxHeightCells?: number;
    filename?: string;
}
export declare class Image implements Component {
    #private;
    constructor(base64Data: string, mimeType: string, theme: ImageTheme, options?: ImageOptions, dimensions?: ImageDimensions);
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=image.d.ts.map