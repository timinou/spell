import { describe, expect, it } from "bun:test";
import { escapeForTelegram, escapeHtml, escapeMarkdown, escapeMarkdownV2 } from "../../src/telegram/escape";

describe("telegram escape utilities", () => {
	describe("escapeMarkdownV2", () => {
		it("escapes all 18 reserved characters", () => {
			const input = "_*[]()~`>#+-=|{}.!";
			const expected = "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!";
			expect(escapeMarkdownV2(input)).toBe(expected);
		});

		it("escapes characters within text", () => {
			expect(escapeMarkdownV2("hello *world*")).toBe("hello \\*world\\*");
			expect(escapeMarkdownV2("click [here](url)")).toBe("click \\[here\\]\\(url\\)");
		});

		it("escapes underscore and other markdown chars", () => {
			expect(escapeMarkdownV2("_italic_")).toBe("\\_italic\\_");
			expect(escapeMarkdownV2("test#anchor")).toBe("test\\#anchor");
		});

		it("handles empty string", () => {
			expect(escapeMarkdownV2("")).toBe("");
		});
	});

	describe("escapeMarkdown", () => {
		it("escapes the 4 legacy markdown reserved characters", () => {
			const input = "_*`[";
			const expected = "\\_\\*\\`\\[";
			expect(escapeMarkdown(input)).toBe(expected);
		});

		it("does not escape MarkdownV2-only characters", () => {
			expect(escapeMarkdown("hello#world")).toBe("hello#world");
			expect(escapeMarkdown("a>b")).toBe("a>b");
			expect(escapeMarkdown("a{b}c")).toBe("a{b}c");
		});

		it("escapes within text", () => {
			expect(escapeMarkdown("_italic_")).toBe("\\_italic\\_");
			expect(escapeMarkdown("*bold*")).toBe("\\*bold\\*");
		});

		it("handles empty string", () => {
			expect(escapeMarkdown("")).toBe("");
		});
	});

	describe("escapeHtml", () => {
		it("escapes ampersand, less-than, and greater-than", () => {
			expect(escapeHtml("&")).toBe("&amp;");
			expect(escapeHtml("<")).toBe("&lt;");
			expect(escapeHtml(">")).toBe("&gt;");
		});

		it("escapes all three in combination", () => {
			expect(escapeHtml("<script>alert('xss')</script>")).toBe(
				"&lt;script&gt;alert('xss')&lt;/script&gt;",
			);
			expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
		});

		it("does not escape other characters", () => {
			expect(escapeHtml("hello world")).toBe("hello world");
			expect(escapeHtml("test_*`[]()")).toBe("test_*`[]()");
		});

		it("handles empty string", () => {
			expect(escapeHtml("")).toBe("");
		});
	});

	describe("escapeForTelegram", () => {
		it("uses MarkdownV2 escape when parseMode is MarkdownV2", () => {
			expect(escapeForTelegram("MarkdownV2", "hello*world")).toBe("hello\\*world");
			expect(escapeForTelegram("MarkdownV2", "_text_")).toBe("\\_text\\_");
		});

		it("uses Markdown escape when parseMode is Markdown", () => {
			expect(escapeForTelegram("Markdown", "*text*")).toBe("\\*text\\*");
			expect(escapeForTelegram("Markdown", "hello#world")).toBe("hello#world");
		});

		it("uses HTML escape when parseMode is HTML", () => {
			expect(escapeForTelegram("HTML", "<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
			expect(escapeForTelegram("HTML", "a & b")).toBe("a &amp; b");
		});

		it("returns raw string when parseMode is undefined", () => {
			expect(escapeForTelegram(undefined, "hello*world")).toBe("hello*world");
			expect(escapeForTelegram(undefined, "<script>")).toBe("<script>");
		});

		it("returns empty string when input is empty", () => {
			expect(escapeForTelegram("MarkdownV2", "")).toBe("");
			expect(escapeForTelegram("Markdown", "")).toBe("");
			expect(escapeForTelegram("HTML", "")).toBe("");
			expect(escapeForTelegram(undefined, "")).toBe("");
		});
	});
});
