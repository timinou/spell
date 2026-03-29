import { padding, truncateToWidth } from "../utils";
/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText {
    #text;
    #paddingX;
    #paddingY;
    constructor(text, paddingX = 0, paddingY = 0) {
        this.#text = text;
        this.#paddingX = paddingX;
        this.#paddingY = paddingY;
    }
    invalidate() {
        // No cached state to invalidate currently
    }
    render(width) {
        const result = [];
        // Empty line padded to width
        const emptyLine = padding(width);
        // Add vertical padding above
        for (let i = 0; i < this.#paddingY; i++) {
            result.push(emptyLine);
        }
        // Calculate available width after horizontal padding
        const availableWidth = Math.max(1, width - this.#paddingX * 2);
        // Take only the first line (stop at newline)
        let singleLineText = this.#text;
        const newlineIndex = this.#text.indexOf("\n");
        if (newlineIndex !== -1) {
            singleLineText = this.#text.substring(0, newlineIndex);
        }
        // Truncate text if needed (accounting for ANSI codes)
        const displayText = truncateToWidth(singleLineText, availableWidth);
        // Add horizontal padding
        const leftPadding = padding(this.#paddingX);
        const rightPadding = padding(this.#paddingX);
        const lineWithPadding = leftPadding + displayText + rightPadding;
        // Don't pad to full width - avoids trailing spaces when copying
        result.push(lineWithPadding);
        // Add vertical padding below
        for (let i = 0; i < this.#paddingY; i++) {
            result.push(emptyLine);
        }
        return result;
    }
}
//# sourceMappingURL=truncated-text.js.map