import { matchesKey } from "../keys";
import { padding, replaceTabs, truncateToWidth, visibleWidth } from "../utils";
function sanitizeSingleLine(text) {
    return replaceTabs(text)
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export class SelectList {
    #filteredItems;
    #selectedIndex = 0;
    #parent;
    setParent(p) {
        this.#parent = p;
    }
    constructor(items, maxVisible, theme) {
        this.items = items;
        this.maxVisible = maxVisible;
        this.theme = theme;
        this.#filteredItems = items;
    }
    setFilter(filter) {
        this.#filteredItems = this.items.filter(item => item.value.toLowerCase().startsWith(filter.toLowerCase()));
        // Reset selection when filter changes
        this.#selectedIndex = 0;
        this.#parent?.markDirty();
    }
    setSelectedIndex(index) {
        this.#selectedIndex = Math.max(0, Math.min(index, this.#filteredItems.length - 1));
        this.#parent?.markDirty();
    }
    invalidate() {
        this.#parent?.markDirty();
    }
    render(width) {
        const lines = [];
        // If no items match filter, show message
        if (this.#filteredItems.length === 0) {
            lines.push(this.theme.noMatch("  No matching commands"));
            return lines;
        }
        // Calculate visible range with scrolling
        const startIndex = Math.max(0, Math.min(this.#selectedIndex - Math.floor(this.maxVisible / 2), this.#filteredItems.length - this.maxVisible));
        const endIndex = Math.min(startIndex + this.maxVisible, this.#filteredItems.length);
        // Render visible items
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.#filteredItems[i];
            if (!item)
                continue;
            const isSelected = i === this.#selectedIndex;
            const labelText = sanitizeSingleLine(item.label || item.value);
            const descriptionText = item.description ? sanitizeSingleLine(item.description) : undefined;
            let line = "";
            if (isSelected) {
                // Use arrow indicator for selection - entire line uses selectedText color
                const prefix = `${this.theme.symbols.cursor} `;
                const prefixWidth = visibleWidth(prefix);
                const displayValue = labelText;
                if (descriptionText && width > 40) {
                    // Calculate how much space we have for value + description
                    const maxValueWidth = Math.min(30, width - prefixWidth - 4);
                    const truncatedValue = truncateToWidth(displayValue, maxValueWidth, 2 /* Ellipsis.Omit */);
                    const spacing = padding(Math.max(1, 32 - truncatedValue.length));
                    // Calculate remaining space for description using visible widths
                    const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
                    const remainingWidth = width - descriptionStart - 2; // -2 for safety
                    if (remainingWidth > 10) {
                        const truncatedDesc = truncateToWidth(descriptionText, remainingWidth, 2 /* Ellipsis.Omit */);
                        // Apply selectedText to entire line content
                        line = this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
                    }
                    else {
                        // Not enough space for description
                        const maxWidth = width - prefixWidth - 2;
                        line = this.theme.selectedText(`${prefix}${truncateToWidth(displayValue, maxWidth, 2 /* Ellipsis.Omit */)}`);
                    }
                }
                else {
                    // No description or not enough width
                    const maxWidth = width - prefixWidth - 2;
                    line = this.theme.selectedText(`${prefix}${truncateToWidth(displayValue, maxWidth, 2 /* Ellipsis.Omit */)}`);
                }
            }
            else {
                const displayValue = labelText;
                const prefix = padding(visibleWidth(this.theme.symbols.cursor) + 1);
                if (descriptionText && width > 40) {
                    // Calculate how much space we have for value + description
                    const maxValueWidth = Math.min(30, width - prefix.length - 4);
                    const truncatedValue = truncateToWidth(displayValue, maxValueWidth, 2 /* Ellipsis.Omit */);
                    const spacing = padding(Math.max(1, 32 - truncatedValue.length));
                    // Calculate remaining space for description
                    const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
                    const remainingWidth = width - descriptionStart - 2; // -2 for safety
                    if (remainingWidth > 10) {
                        const truncatedDesc = truncateToWidth(descriptionText, remainingWidth, 2 /* Ellipsis.Omit */);
                        const descText = this.theme.description(spacing + truncatedDesc);
                        line = prefix + truncatedValue + descText;
                    }
                    else {
                        // Not enough space for description
                        const maxWidth = width - prefix.length - 2;
                        line = prefix + truncateToWidth(displayValue, maxWidth, 2 /* Ellipsis.Omit */);
                    }
                }
                else {
                    // No description or not enough width
                    const maxWidth = width - prefix.length - 2;
                    line = prefix + truncateToWidth(displayValue, maxWidth, 2 /* Ellipsis.Omit */);
                }
            }
            lines.push(line);
        }
        // Add scroll indicators if needed
        if (startIndex > 0 || endIndex < this.#filteredItems.length) {
            const scrollText = `  (${this.#selectedIndex + 1}/${this.#filteredItems.length})`;
            // Truncate if too long for terminal
            lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, 2 /* Ellipsis.Omit */)));
        }
        return lines;
    }
    handleInput(keyData) {
        try {
            if (this.#filteredItems.length === 0)
                return;
            // Up arrow - wrap to bottom when at top
            if (matchesKey(keyData, "up")) {
                this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
                this.#notifySelectionChange();
            }
            // Down arrow - wrap to top when at bottom
            else if (matchesKey(keyData, "down")) {
                this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
                this.#notifySelectionChange();
            }
            // PageUp - jump up by one visible page
            else if (matchesKey(keyData, "pageUp")) {
                this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisible);
                this.#notifySelectionChange();
            }
            // PageDown - jump down by one visible page
            else if (matchesKey(keyData, "pageDown")) {
                this.#selectedIndex = Math.min(this.#filteredItems.length - 1, this.#selectedIndex + this.maxVisible);
                this.#notifySelectionChange();
            }
            // Enter
            else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
                const selectedItem = this.#filteredItems[this.#selectedIndex];
                if (selectedItem && this.onSelect) {
                    this.onSelect(selectedItem);
                }
            }
            // Escape or Ctrl+C
            else if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
                if (this.onCancel) {
                    this.onCancel();
                }
            }
        }
        finally {
            // BUG-391: ensure dirty propagates regardless of which branch ran.
            // The Container dirty-cache (FEAT-762) serves stale lines otherwise.
            this.#parent?.markDirty();
        }
    }
    #notifySelectionChange() {
        const selectedItem = this.#filteredItems[this.#selectedIndex];
        if (selectedItem && this.onSelectionChange) {
            this.onSelectionChange(selectedItem);
        }
    }
    getSelectedItem() {
        const item = this.#filteredItems[this.#selectedIndex];
        return item || null;
    }
}
//# sourceMappingURL=select-list.js.map