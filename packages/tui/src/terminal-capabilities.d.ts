export declare enum ImageProtocol {
    Kitty = "\u001B_G",
    Iterm2 = "\u001B]1337;File=",
    Sixel = "\u001BPq"
}
export declare enum NotifyProtocol {
    Bell = "\u0007",
    Osc99 = "\u001B]99;;",
    Osc9 = "\u001B]9;"
}
export type TerminalId = "kitty" | "ghostty" | "wezterm" | "iterm2" | "vscode" | "alacritty" | "base" | "trueColor";
/** Terminal capability details used for rendering and protocol selection. */
export declare class TerminalInfo {
    readonly id: TerminalId;
    readonly imageProtocol: ImageProtocol | null;
    readonly trueColor: boolean;
    readonly hyperlinks: boolean;
    readonly notifyProtocol: NotifyProtocol;
    constructor(id: TerminalId, imageProtocol: ImageProtocol | null, trueColor: boolean, hyperlinks: boolean, notifyProtocol?: NotifyProtocol);
    isImageLine(line: string): boolean;
    formatNotification(message: string): string;
    sendNotification(message: string): void;
}
export declare function isNotificationSuppressed(): boolean;
/**
 * Returns true when running in Windows Terminal with known SIXEL support.
 *
 * Windows Terminal introduced SIXEL support in preview 1.22.
 */
export declare function isWindowsTerminalPreviewSixelSupported(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): boolean;
export declare const TERMINAL_ID: TerminalId;
export declare const TERMINAL: TerminalInfo;
/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export declare function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void;
/**
 * Clear visible image placements from the terminal before rendering text-only overlays.
 * Kitty placements float above text, so they must be explicitly deleted.
 */
export declare function clearImagePlacements(): void;
export declare function getTerminalInfo(terminalId: TerminalId): TerminalInfo;
export interface CellDimensions {
    widthPx: number;
    heightPx: number;
}
export interface ImageDimensions {
    widthPx: number;
    heightPx: number;
}
export interface ImageRenderOptions {
    maxWidthCells?: number;
    maxHeightCells?: number;
    preserveAspectRatio?: boolean;
}
export declare function getCellDimensions(): CellDimensions;
export declare function setCellDimensions(dims: CellDimensions): void;
export declare function encodeKitty(base64Data: string, options?: {
    columns?: number;
    rows?: number;
    imageId?: number;
}): string;
export declare function encodeITerm2(base64Data: string, options?: {
    width?: number | string;
    height?: number | string;
    name?: string;
    preserveAspectRatio?: boolean;
    inline?: boolean;
}): string;
export declare function calculateImageRows(imageDimensions: ImageDimensions, targetWidthCells: number, cellDimensions?: CellDimensions): number;
export declare function getPngDimensions(base64Data: string): ImageDimensions | null;
export declare function getJpegDimensions(base64Data: string): ImageDimensions | null;
export declare function getGifDimensions(base64Data: string): ImageDimensions | null;
export declare function getWebpDimensions(base64Data: string): ImageDimensions | null;
export declare function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null;
export declare function renderImage(base64Data: string, imageDimensions: ImageDimensions, options?: ImageRenderOptions): {
    sequence: string;
    rows: number;
} | null;
export declare function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string;
//# sourceMappingURL=terminal-capabilities.d.ts.map