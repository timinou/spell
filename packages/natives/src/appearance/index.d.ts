/**
 * macOS appearance detection via native CoreFoundation APIs.
 *
 * This is a fallback capability for terminals whose own dark/light reporting is
 * unavailable or known-broken. It reports the host macOS appearance, not the
 * terminal profile colors.
 */
export type { MacAppearanceObserver } from "./types";
/**
 * Detect macOS system appearance.
 * Returns `"dark"` or `"light"` on macOS, `undefined` on other platforms.
 */
export declare function detectMacOSAppearance(): "dark" | "light" | undefined;
/**
 * Start a long-lived macOS appearance observer.
 * Calls `callback` with `"dark"` or `"light"` on each system appearance change
 * (and once immediately on start).
 *
 * Returns an observer handle with a `stop()` method.
 * On non-macOS platforms, returns a no-op observer.
 */
export declare function startMacAppearanceObserver(callback: (appearance: "dark" | "light") => void): {
    stop(): void;
};
//# sourceMappingURL=index.d.ts.map