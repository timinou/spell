import { describe, expect, it } from "bun:test";
import { escapeHtml, markdownToTelegramHtml } from "../../src/telegram/bridge/markdown-html";

describe("escapeHtml", () => {
	it("escapes ampersand, less-than, and greater-than", () => {
		expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});
});

describe("markdownToTelegramHtml", () => {
	it("returns empty string for empty input", () => {
		expect(markdownToTelegramHtml("")).toBe("");
	});

	it("preserves whitespace-only content", () => {
		expect(markdownToTelegramHtml("   \n\t")).toBe("   \n\t");
	});

	it("converts code blocks to pre/code with language class", () => {
		const markdown = "```ts\nconst value = a < b && c > d;\n```";
		const html = markdownToTelegramHtml(markdown);
		expect(html).toBe('<pre><code class="language-ts">const value = a &lt; b &amp;&amp; c &gt; d;\n</code></pre>');
	});

	it("converts inline code to code tags", () => {
		expect(markdownToTelegramHtml("Use `bun test` now")).toBe("Use <code>bun test</code> now");
	});

	it("converts bold and italic syntax", () => {
		expect(markdownToTelegramHtml("**bold** and *italic* plus __more bold__ and _more italic_")).toBe(
			"<b>bold</b> and <i>italic</i> plus <b>more bold</b> and <i>more italic</i>",
		);
	});

	it("converts links to anchor tags and preserves URL special chars", () => {
		const markdown = "[search](https://example.com?q=one&two=2)";
		expect(markdownToTelegramHtml(markdown)).toBe('<a href="https://example.com?q=one&amp;two=2">search</a>');
	});

	it("converts headers to bold lines", () => {
		const markdown = "# Title\n## Subtitle\n### Section";
		expect(markdownToTelegramHtml(markdown)).toBe("<b>Title</b>\n<b>Subtitle</b>\n<b>Section</b>");
	});

	it("escapes HTML chars in code blocks and prevents script injection", () => {
		const markdown = "```html\n<script>alert('xss')</script>\n```";
		expect(markdownToTelegramHtml(markdown)).toBe(
			"<pre><code class=\"language-html\">&lt;script&gt;alert('xss')&lt;/script&gt;\n</code></pre>",
		);
	});

	it("handles nested formatting with bold inside italic", () => {
		expect(markdownToTelegramHtml("*hello **world**!*")).toBe("<i>hello <b>world</b>!</i>");
	});

	it("passes through plain text with HTML escaping", () => {
		expect(markdownToTelegramHtml("plain <text> & more")).toBe("plain &lt;text&gt; &amp; more");
	});

	it("preserves double newlines between paragraphs", () => {
		expect(markdownToTelegramHtml("First paragraph\n\nSecond paragraph")).toBe("First paragraph\n\nSecond paragraph");
	});

	it("leaves unmatched delimiters as-is", () => {
		expect(markdownToTelegramHtml("This *never closes and _also stays")).toBe("This *never closes and _also stays");
	});

	it("does not convert markdown syntax inside code blocks", () => {
		const markdown = "```txt\n**not bold** and _not italic_\n```";
		expect(markdownToTelegramHtml(markdown)).toBe(
			'<pre><code class="language-txt">**not bold** and _not italic_\n</code></pre>',
		);
	});
});
