/**
 * Markdown to Telegram HTML converter.
 *
 * Telegram supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a href>, <blockquote>
 * This converts a common subset of Markdown to that format.
 */

/** Escape HTML special chars for Telegram HTML mode */
export function escapeHtml(input: string): string {
	return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Convert Markdown to Telegram-compatible HTML */
export function markdownToTelegramHtml(markdown: string): string {
	if (!markdown) return "";

	// Phase 1: Extract and protect code blocks (```...```)
	const codeBlocks: string[] = [];
	let text = markdown.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const escapedCode = escapeHtml(code.replace(/\n$/, ""));
		const langAttr = lang ? ` class="language-${lang}"` : "";
		const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
		codeBlocks.push(`<pre><code${langAttr}>${escapedCode}\n</code></pre>`);
		return placeholder;
	});

	// Phase 2: Extract and protect inline code (`...`)
	const inlineCodes: string[] = [];
	text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		const placeholder = `\x00INLINE${inlineCodes.length}\x00`;
		inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
		return placeholder;
	});

	// Phase 3: Escape HTML in remaining text
	text = escapeHtml(text);

	// Phase 4: Convert markdown formatting
	// Bold: **text** and __text__
	text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	text = text.replace(/__(.+?)__/g, "<b>$1</b>");

	// Italic: *text* and _text_ (not inside words for underscore)
	text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
	text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

	// Strikethrough: ~~text~~
	text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Links: [text](url) - URL was already HTML-escaped, that's fine for href
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	// Headers: # Title -> bold text (per line)
	text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

	// Phase 5: Restore protected content
	for (let i = 0; i < inlineCodes.length; i++) {
		text = text.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
	}
	for (let i = 0; i < codeBlocks.length; i++) {
		text = text.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
	}

	return text;
}
