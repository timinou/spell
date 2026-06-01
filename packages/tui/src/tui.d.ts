import type { Terminal } from "./terminal";
import { visibleWidth } from "./utils";
type InputListenerResult = {
    consume?: boolean;
    data?: string;
} | undefined;
type InputListener = (data: string) => InputListenerResult;
/**
 * Minimal interface for anything that can serve as a parent for dirty propagation.
 * Containers implement this directly; Box and other Container-like wrappers can
 * implement it too without needing to inherit from Container.
 */
export interface DirtyParent {
    markDirty(): void;
}
/**
 * Component interface - all components must implement this
 */
export interface Component {
    /**
     * Render the component to lines for the given viewport width
     * @param width - Current viewport width
     * @returns Array of strings, each representing a line
     */
    render(width: number): string[];
    /**
     * Optional handler for keyboard input when component has focus
     */
    handleInput?(data: string): void;
    /**
     * Optional invalidate hook — clear any internal cache + signal that the
     * component needs re-rendering. Should call #parent.markDirty() if a parent
     * has been set, to propagate dirty up the tree.
     */
    invalidate?(): void;
    /**
     * Optional parent assignment — set by addChild / clear / removeChild on
     * Container and Container-like (Box). Enables upward dirty propagation.
     */
    setParent?(parent: DirtyParent | undefined): void;
    /**
     * If true, component receives key release events (Kitty protocol).
     * Default is false - release events are filtered out.
     */
    wantsKeyRelease?: boolean;
}
/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
    /** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
    focused: boolean;
}
/** Type guard to check if a component implements Focusable */
export declare function isFocusable(component: Component | null): component is Component & Focusable;
/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export declare const CURSOR_MARKER = "\u001B_pi:c\u0007";
/**
 * Spinner marker — APC (Application Program Command) zero-width sentinel.
 * Renderers emit this where they want the live spinner glyph. TUI substitutes
 * it with the current frame at render time, so the renderer body itself does
 * not need to run on every spinner tick. Frame source is the shared
 * `spinnerClock`; the active glyph set is configured via `setSpinnerFrames`.
 */
export declare const SPINNER_MARKER = "\u001B_pi:spin\u0007";
export { visibleWidth };
/**
 * Anchor position for overlays
 */
export type OverlayAnchor = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "left-center" | "right-center";
/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}
/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;
/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
    /** Width in columns, or percentage of terminal width (e.g., "50%") */
    width?: SizeValue;
    /** Minimum width in columns */
    minWidth?: number;
    /** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
    maxHeight?: SizeValue;
    /** Anchor point for positioning (default: 'center') */
    anchor?: OverlayAnchor;
    /** Horizontal offset from anchor position (positive = right) */
    offsetX?: number;
    /** Vertical offset from anchor position (positive = down) */
    offsetY?: number;
    /** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
    row?: SizeValue;
    /** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
    col?: SizeValue;
    /** Margin from terminal edges. Number applies to all sides. */
    margin?: OverlayMargin | number;
    /**
     * Control overlay visibility based on terminal dimensions.
     * If provided, overlay is only rendered when this returns true.
     * Called each render cycle with current terminal dimensions.
     */
    visible?: (termWidth: number, termHeight: number) => boolean;
    /** If false, the overlay does not steal focus from the current component. Default: true. */
    focusable?: boolean;
    /** Higher layers render on top during compositing. Default: 0. */
    layer?: number;
}
/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
}
/**
 * Container - a component that contains other components
 */
export declare class Container implements Component {
    #private;
    children: Component[];
    setParent(p: DirtyParent | undefined): void;
    markDirty(): void;
    isDirty(): boolean;
    /** Mark this Container and every descendant Container dirty WITHOUT
     *  invalidating leaf-component caches. Used by TUI.requestRender to
     *  defeat per-Container cache without losing the leaf-level cache wins
     *  (Markdown.#cachedText etc.). Leaves keep their own caches; if their
     *  state actually changed they invalidate themselves via their own setters. */
    /** Mark this Container and all descendant Containers dirty.
     *  Unlike invalidate(), this recursively walks the subtree and
     *  also calls Component.invalidate() on leaf components. */
    markTreeDirty(): void;
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    invalidate(): void;
    render(width: number): string[];
}
/**
 * Options for {@link TUI.requestRender}.
 */
export interface RenderRequestOptions {
    /** When paired with a forced render, also wipe terminal scrollback (a true
     * session replace, e.g. /clear). Honored outside multiplexers. Default off:
     * forced redraws preserve scrollback so the user's history survives resize,
     * focus changes, and post-init repaints. */
    clearScrollback?: boolean;
}
export declare class TUI extends Container {
    #private;
    terminal: Terminal;
    /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
    onDebug?: () => void;
    overlayStack: {
        component: Component;
        options?: OverlayOptions;
        preFocus: Component | null;
        hidden: boolean;
    }[];
    constructor(terminal: Terminal, options?: boolean | {
        showHardwareCursor?: boolean;
        minRenderInterval?: number;
        spinnerFrames?: string[];
    });
    /**
     * Update the active spinner glyph set. Safe to call at runtime when the
     * theme changes; existing subscription (if any) keeps ticking and just
     * picks the new glyph on the next frame.
     */
    setSpinnerFrames(frames: string[]): void;
    get fullRedraws(): number;
    getShowHardwareCursor(): boolean;
    setShowHardwareCursor(enabled: boolean): void;
    getClearOnShrink(): boolean;
    /**
     * Set whether to trigger full re-render when content shrinks.
     * When true (default), empty rows are cleared when content shrinks.
     * When false, empty rows remain (reduces redraws on slower terminals).
     */
    setClearOnShrink(enabled: boolean): void;
    setFocus(component: Component | null): void;
    /**
     * Show an overlay component with configurable positioning and sizing.
     * Returns a handle to control the overlay's visibility.
     */
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    /** Hide the topmost overlay and restore previous focus. */
    hideOverlay(): void;
    /** Check if there are any visible overlays */
    hasOverlay(): boolean;
    invalidate(): void;
    start(): void;
    addInputListener(listener: InputListener): () => void;
    removeInputListener(listener: InputListener): void;
    stop(): void;
    /**
     * Set the minimum interval (ms) between renders. Used by consumers to
     * throttle rendering when the terminal is not visible (e.g. niri
     * overview, terminal unfocused). 0 disables throttling.
     */
    setMinRenderInterval(ms: number): void;
    /** Current minimum render interval (ms). */
    get minRenderInterval(): number;
    requestRender(force?: boolean, options?: RenderRequestOptions): void;
}
//# sourceMappingURL=tui.d.ts.map