import { describe, expect, it } from "bun:test";
import { splitMessage } from "../../src/telegram/bridge/message-splitter";

describe("splitMessage", () => {
	it("returns a single chunk when message is under max length", () => {
		const message = "Hello <b>world</b>";
		expect(splitMessage(message, 4096)).toEqual([message]);
	});

	it("splits long messages at paragraph boundaries first", () => {
		const message = "Paragraph one has some text.\n\nParagraph two has some text.";
		const chunks = splitMessage(message, 35);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.endsWith("\n\n")).toBe(true);
		expect(chunks.join("")).toBe(message);
	});

	it("keeps <pre> blocks whole and never splits them mid-block", () => {
		const preBody = "x".repeat(80);
		const preBlock = `<pre>${preBody}</pre>`;
		const message = `Intro text\n\n${preBlock}\n\nTail text`;
		const chunks = splitMessage(message, 40);

		expect(chunks.some(chunk => chunk.includes(preBlock))).toBe(true);
		expect(chunks.join("")).toContain(preBlock);
		expect(chunks.some(chunk => chunk.includes("<pre>") && !chunk.includes("</pre>"))).toBe(false);
	});

	it("closes and reopens supported HTML tags across split boundaries", () => {
		const message = `<b>${"word ".repeat(20)}</b>`;
		const chunks = splitMessage(message, 45);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.endsWith("</b>")).toBe(true);
		expect(chunks[1]?.startsWith("<b>")).toBe(true);
	});

	it("splits very long single lines at word boundaries", () => {
		const message = "one two three four five six seven";
		const chunks = splitMessage(message, 10);

		expect(chunks.length).toBeGreaterThan(1);
		for (const [index, chunk] of chunks.entries()) {
			if (index < chunks.length - 1) {
				expect(chunk.endsWith(" ")).toBe(true);
			}
			expect(chunk.length).toBeLessThanOrEqual(10);
		}
		expect(chunks.join("")).toBe(message);
	});

	it("returns [''] or [] for empty input", () => {
		const chunks = splitMessage("");
		expect(chunks.length === 0 || (chunks.length === 1 && chunks[0] === "")).toBe(true);
	});

	it("returns a single chunk for message exactly at max length", () => {
		const message = "a".repeat(4096);
		expect(splitMessage(message)).toEqual([message]);
	});

	it("properly closes and reopens nested tags", () => {
		const message = `<blockquote><b><i>${"nested text ".repeat(16)}</i></b></blockquote>`;
		const chunks = splitMessage(message, 70);

		expect(chunks.length).toBeGreaterThan(1);
		for (const [index, chunk] of chunks.entries()) {
			if (index < chunks.length - 1) {
				expect(chunk.endsWith("</i></b></blockquote>")).toBe(true);
			}
			if (index > 0) {
				expect(chunk.startsWith("<blockquote><b><i>")).toBe(true);
			}
		}
	});
});
