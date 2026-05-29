import { type Component, type DirtyParent, type Focusable } from "../tui";
/**
 * Input component - single-line text input with horizontal scrolling
 */
export declare class Input implements Component, Focusable {
    #private;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    /** Focusable interface - set by TUI when focus changes */
    focused: boolean;
    setParent(p: DirtyParent | undefined): void;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=input.d.ts.map