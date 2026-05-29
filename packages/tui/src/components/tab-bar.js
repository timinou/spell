/**
 * Tab Bar Component
 *
 * A horizontal tab bar for switching between views/panels.
 * Renders as: "Label:  Tab1   Tab2   Tab3  (tab to cycle)"
 *
 * Navigation:
 * - Tab / Arrow Right: Next tab (wraps around)
 * - Shift+Tab / Arrow Left: Previous tab (wraps around)
 */
import { matchesKey } from "../keys";
import { truncateToWidth, visibleWidth } from "../utils";
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
export class TabBar {
    #tabs;
    #activeIndex = 0;
    #theme;
    #label;
    #parent;
    setParent(p) {
        this.#parent = p;
    }
    constructor(label, tabs, theme, initialIndex = 0) {
        this.#label = label;
        this.#tabs = tabs;
        this.#theme = theme;
        this.#activeIndex = initialIndex;
    }
    /** Get the currently active tab */
    getActiveTab() {
        return this.#tabs[this.#activeIndex];
    }
    /** Get the index of the currently active tab */
    getActiveIndex() {
        return this.#activeIndex;
    }
    /** Set the active tab by index (clamped to valid range) */
    setActiveIndex(index) {
        const newIndex = Math.max(0, Math.min(index, this.#tabs.length - 1));
        if (newIndex !== this.#activeIndex) {
            this.#activeIndex = newIndex;
            this.onTabChange?.(this.#tabs[this.#activeIndex], this.#activeIndex);
            this.#parent?.markDirty();
        }
    }
    /** Move to the next tab (wraps to first tab after last) */
    nextTab() {
        this.setActiveIndex((this.#activeIndex + 1) % this.#tabs.length);
    }
    /** Move to the previous tab (wraps to last tab before first) */
    prevTab() {
        this.setActiveIndex((this.#activeIndex - 1 + this.#tabs.length) % this.#tabs.length);
    }
    invalidate() {
        this.#parent?.markDirty();
    }
    /**
     * Handle keyboard input for tab navigation.
     * @returns true if the input was handled, false otherwise
     */
    handleInput(data) {
        if (matchesKey(data, "tab") || matchesKey(data, "right")) {
            this.nextTab();
            return true;
        }
        if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
            this.prevTab();
            return true;
        }
        return false;
    }
    /** Render the tab bar, wrapping to multiple lines if needed */
    render(width) {
        const maxWidth = Math.max(1, width);
        const chunks = [];
        // Label prefix
        chunks.push(this.#theme.label(`${this.#label}:`));
        chunks.push("  ");
        // Tab buttons
        for (let i = 0; i < this.#tabs.length; i++) {
            const tab = this.#tabs[i];
            if (i === this.#activeIndex) {
                chunks.push(this.#theme.activeTab(` ${tab.label} `));
            }
            else {
                chunks.push(this.#theme.inactiveTab(` ${tab.label} `));
            }
            if (i < this.#tabs.length - 1) {
                chunks.push("  ");
            }
        }
        // Navigation hint
        chunks.push("  ");
        chunks.push(this.#theme.hint("(tab to cycle)"));
        const lines = [];
        let currentLine = "";
        let currentWidth = 0;
        for (const chunk of chunks) {
            const chunkWidth = visibleWidth(chunk);
            if (chunkWidth <= 0) {
                continue;
            }
            if (chunkWidth > maxWidth) {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = "";
                    currentWidth = 0;
                }
                lines.push(truncateToWidth(chunk, maxWidth));
                continue;
            }
            if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
                lines.push(currentLine);
                currentLine = "";
                currentWidth = 0;
            }
            currentLine += chunk;
            currentWidth += chunkWidth;
        }
        if (currentLine) {
            lines.push(currentLine);
        }
        return lines.length > 0 ? lines : [""];
    }
}
//# sourceMappingURL=tab-bar.js.map