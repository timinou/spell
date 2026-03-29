/**
 * HTML to Markdown conversion powered by native bindings.
 */
import { native } from "../native";
/**
 * Convert HTML to Markdown.
 *
 * @param html - HTML content to convert
 * @param options - Conversion options
 * @returns Markdown text
 */
export async function htmlToMarkdown(html, options) {
    return native.htmlToMarkdown(html, options);
}
//# sourceMappingURL=index.js.map