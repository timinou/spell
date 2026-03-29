/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export declare function emergencyTerminalRestore(): void;
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    /**
     * Drain stdin before exiting to prevent Kitty key release events from
     * leaking to the parent shell over slow SSH connections.
     * @param maxMs - Maximum time to drain (default: 1000ms)
     * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
     */
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    get kittyProtocolActive(): boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    /**
     * Register a callback for terminal appearance (dark/light) changes.
     * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
     * Fires when the detected appearance changes, including the initial detection.
     */
    onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;
    /** The last detected terminal appearance, or undefined if not yet known. */
    get appearance(): TerminalAppearance | undefined;
}
/**
 * Real terminal using process.stdin/stdout
 */
export declare class ProcessTerminal implements Terminal {
    #private;
    get kittyProtocolActive(): boolean;
    get appearance(): TerminalAppearance | undefined;
    onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;
    start(onInput: (data: string) => void, onResize: () => void): void;
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
}
//# sourceMappingURL=terminal.d.ts.map