import type { Component } from "../tui";
/** Tab definition */
export interface Tab {
    /** Unique identifier for the tab */
    id: string;
    /** Display label shown in the tab bar */
    label: string;
}
/** Theme for styling the tab bar */
export interface TabBarTheme {
    /** Style for the label prefix (e.g., "Settings:") */
    label: (text: string) => string;
    /** Style for the currently active tab */
    activeTab: (text: string) => string;
    /** Style for inactive tabs */
    inactiveTab: (text: string) => string;
    /** Style for the hint text (e.g., "(tab to cycle)") */
    hint: (text: string) => string;
}
/**
 * Horizontal tab bar component.
 *
 * @example
 * ```ts
 * const tabs = [
 *   { id: "config", label: "Config" },
 *   { id: "tools", label: "Tools" },
 * ];
 * const tabBar = new TabBar("Settings", tabs, theme);
 * tabBar.onTabChange = (tab) => console.log(`Switched to ${tab.id}`);
 * ```
 */
export declare class TabBar implements Component {
    #private;
    /** Callback fired when the active tab changes */
    onTabChange?: (tab: Tab, index: number) => void;
    constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex?: number);
    /** Get the currently active tab */
    getActiveTab(): Tab;
    /** Get the index of the currently active tab */
    getActiveIndex(): number;
    /** Set the active tab by index (clamped to valid range) */
    setActiveIndex(index: number): void;
    /** Move to the next tab (wraps to first tab after last) */
    nextTab(): void;
    /** Move to the previous tab (wraps to last tab before first) */
    prevTab(): void;
    invalidate(): void;
    /**
     * Handle keyboard input for tab navigation.
     * @returns true if the input was handled, false otherwise
     */
    handleInput(data: string): boolean;
    /** Render the tab bar, wrapping to multiple lines if needed */
    render(width: number): string[];
}
//# sourceMappingURL=tab-bar.d.ts.map