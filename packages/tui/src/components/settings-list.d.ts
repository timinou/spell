import type { Component, DirtyParent } from "../tui";
export interface SettingItem {
    /** Unique identifier for this setting */
    id: string;
    /** Display label (left side) */
    label: string;
    /** Optional description shown when selected */
    description?: string;
    /** Current value to display (right side) */
    currentValue: string;
    /** If provided, Enter/Space cycles through these values */
    values?: string[];
    /** If provided, Enter opens this submenu. Receives current value and done callback. */
    submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}
export interface SettingsListTheme {
    label: (text: string, selected: boolean) => string;
    value: (text: string, selected: boolean) => string;
    description: (text: string) => string;
    cursor: string;
    hint: (text: string) => string;
}
export declare class SettingsList implements Component {
    #private;
    constructor(items: SettingItem[], maxVisible: number, theme: SettingsListTheme, onChange: (id: string, newValue: string) => void, onCancel: () => void);
    /** Update an item's currentValue */
    updateValue(id: string, newValue: string): void;
    setParent(p: DirtyParent | undefined): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(data: string): void;
}
//# sourceMappingURL=settings-list.d.ts.map