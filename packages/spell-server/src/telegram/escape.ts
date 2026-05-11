/** Escape utilities for Telegram message content */

export type TelegramParseMode = "Markdown" | "MarkdownV2" | "HTML" | undefined;

/**
 * MarkdownV2 reserved characters that must be escaped.
 * Source: Telegram Bot API documentation
 * https://core.telegram.org/bots/api#markdownv2-style
 */
const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+=\-|{}.!]/g;

/**
 * Legacy Markdown reserved characters.
 */
const MARKDOWN_RESERVED = /[_*`\[]/g;

/**
 * Escape a string for MarkdownV2 format.
 * All reserved characters are prefixed with a backslash.
 * Reserved chars: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdownV2(raw: string): string {
	return raw.replaceAll(MARKDOWN_V2_RESERVED, match => `\\${match}`);
}

/**
 * Escape a string for legacy Markdown format.
 * Reserved chars: _ * ` [
 */
export function escapeMarkdown(raw: string): string {
	return raw.replaceAll(MARKDOWN_RESERVED, match => `\\${match}`);
}

/**
 * Escape a string for HTML format.
 * Escapes: & < >
 */
export function escapeHtml(raw: string): string {
	return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Escape raw string based on the parse mode.
 * This is a single-pass escape function. Callers are responsible for not double-escaping.
 *
 * @param parseMode The Telegram parse mode being used (or undefined for no formatting)
 * @param raw The raw string to escape
 * @returns The escaped string suitable for the given parse mode
 */
export function escapeForTelegram(parseMode: TelegramParseMode, raw: string): string {
	if (!raw) return raw;

	switch (parseMode) {
		case "MarkdownV2":
			return escapeMarkdownV2(raw);
		case "Markdown":
			return escapeMarkdown(raw);
		case "HTML":
			return escapeHtml(raw);
		case undefined:
		default:
			// No escaping needed when parse_mode is not set
			return raw;
	}
}
