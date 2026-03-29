import type { SymbolTheme } from "../symbols";
import type { Component } from "../tui";
export interface SelectItem {
    value: string;
    label: string;
    description?: string;
    /** Dim hint text shown inline after cursor when this item is selected */
    hint?: string;
}
export interface SelectListTheme {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
    symbols: SymbolTheme;
}
export declare class SelectList implements Component {
    #private;
    private readonly items;
    private readonly maxVisible;
    private readonly theme;
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    onSelectionChange?: (item: SelectItem) => void;
    constructor(items: ReadonlyArray<SelectItem>, maxVisible: number, theme: SelectListTheme);
    setFilter(filter: string): void;
    setSelectedIndex(index: number): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(keyData: string): void;
    getSelectedItem(): SelectItem | null;
}
//# sourceMappingURL=select-list.d.ts.map