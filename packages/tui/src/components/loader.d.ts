import type { TUI } from "../tui";
import { Text } from "./text";
/**
 * Loader component that updates every 80ms with spinning animation
 */
export declare class Loader extends Text {
    #private;
    private spinnerColorFn;
    private messageColorFn;
    private message;
    constructor(ui: TUI, spinnerColorFn: (str: string) => string, messageColorFn: (str: string) => string, message?: string, spinnerFrames?: string[]);
    render(width: number): string[];
    start(): void;
    stop(): void;
    setMessage(message: string): void;
}
//# sourceMappingURL=loader.d.ts.map