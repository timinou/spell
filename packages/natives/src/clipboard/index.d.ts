/**
 * Clipboard helpers backed by native arboard bindings.
 *
 * Adds OSC 52 fallback for SSH/mosh, Termux support, and headless guards
 * on top of the native arboard layer.
 */
import type { ClipboardImage } from "./types";
export type { ClipboardImage } from "./types";
/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts native clipboard copy as best-effort for local sessions.
 * On Termux, tries `termux-clipboard-set` before native.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export declare function copyToClipboard(text: string): Promise<void>;
/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding).
 *
 * @returns PNG payload or null when no image is available.
 */
export declare function readImageFromClipboard(): Promise<ClipboardImage | null>;
//# sourceMappingURL=index.d.ts.map