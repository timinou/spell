import type { DirtyParent, TUI } from "../tui";
import { Text } from "./text";
/**
 * Loader component — spinning animation tied to the shared SpinnerClock.
 *
 * Subscribes only while attached to a parent so detached/queued loaders
 * never drive renders. Visible width matches Text.
 */
export declare class Loader extends Text {
    #private;
    private spinnerColorFn;
    private messageColorFn;
    private message;
    constructor(ui: TUI, spinnerColorFn: (str: string) => string, messageColorFn: (str: string) => string, message?: string, spinnerFrames?: string[]);
    setParent(p: DirtyParent | undefined): void;
    render(width: number): string[];
    start(): void;
    stop(): void;
    setMessage(message: string): void;
}
//# sourceMappingURL=loader.d.ts.map