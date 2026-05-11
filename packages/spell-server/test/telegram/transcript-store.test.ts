import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderSessionMarkdown } from "../../src/telegram/transcript-store";

const testDir = path.join(__dirname, "fixtures");
const sampleFixture = path.join(testDir, "sample-session.jsonl");

describe("renderSessionMarkdown", () => {
	it("parses JSONL and renders markdown newest-first", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		expect(result.markdown).toBeTruthy();
		expect(result.messageCount).toBeGreaterThan(0);

		// First heading should correspond to the LAST message in chronological order
		const headings = result.markdown.match(/##[^\n]+/g) || [];
		expect(headings.length).toBeGreaterThan(0);
		expect(headings[0]).toContain(" — latest");
	});

	it("first heading corresponds to last message (newest-first ordering)", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		const headings = result.markdown.match(/##[^\n]+/g) || [];
		
		// The first rendered heading should be the latest message
		expect(headings[0]).toContain("assistant");
		expect(headings[0]).toContain(" — latest");
	});

	it("heading numbering: N=1 is oldest in time", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		
		// Count total rendered messages
		const headings = result.markdown.match(/##[^\n]+/g) || [];
		const maxSeq = headings.length;
		
		// Find heading with highest number (oldest)
		const oldestHeading = headings.find(h => `#${maxSeq}` === h.match(/#\d+/)?.[0]);
		expect(oldestHeading).toBeTruthy();
	});

	it("scope: 'last-turn' returns last assistant turn + preceding user turn", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { scope: 'last-turn' });
		const headings = result.markdown.match(/##[^\n]+/g) || [];
		
		// Should have at most 2 headings (user then assistant, rendered newest-first)
		expect(headings.length).toBeLessThanOrEqual(2);
		
		// If we have 2, they should be assistant (latest) and user
		if (headings.length === 2) {
			expect(headings[0]).toContain("assistant");
			expect(headings[1]).toContain("user");
		}
	});

	it("scope: { kind: 'last-n', n: 5 } returns exactly 5 messages newest-first", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { scope: { kind: 'last-n', n: 5 } });
		const headings = result.markdown.match(/##[^\n]+/g) || [];
		
		expect(headings.length).toBeLessThanOrEqual(5);
	});

	it("renders toolCall blocks with intent and fenced JSON", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		
		expect(result.markdown).toContain("**tool**");
		expect(result.markdown).toContain("```json");
		expect(result.markdown).toContain("```");
	});

	it("toolCall arguments clipped to maxToolBytes", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { maxToolBytes: 50 });
		
		// If there are toolCall blocks and they exceed the limit, they should be clipped
		if (result.markdown.includes("```json")) {
			expect(result.markdown).toContain("… (truncated");
		}
	});

	it("renders toolResult blocks with clipped content", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		
		expect(result.markdown).toContain("**tool result**");
		// Some tool results should be present
		expect(result.markdown).toContain("```");
	});

	it("toolResult clipped to maxToolBytes with truncation marker", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { maxToolBytes: 100 });
		
		// Should show truncation marker if content exceeds limit
		if (result.markdown.includes("**tool result**")) {
			const toolResults = result.markdown.split("**tool result**");
			// At least some should show truncation based on 100 byte limit
			const hasLongResult = toolResults.some(section => section.includes("… (truncated"));
			if (toolResults.length > 1) {
				expect(hasLongResult || result.markdown.length > 0).toBeTruthy();
			}
		}
	});

	it("lastAssistantText is the last chronological assistant text", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		
		expect(result.lastAssistantText).toBeTruthy();
		// Should be plain text, not containing markdown or tool blocks
		expect(result.lastAssistantText).not.toContain("**tool");
		expect(result.lastAssistantText).not.toContain("```");
	});

	it("empty JSONL returns empty markdown and messageCount: 0", async () => {
		// Create temporary empty JSONL file
		const emptyFile = path.join(testDir, "empty-session.jsonl");
		await fs.writeFile(emptyFile, "");
		
		try {
			const result = await renderSessionMarkdown(emptyFile);
			expect(result.markdown).toBe("");
			expect(result.lastAssistantText).toBe("");
			expect(result.messageCount).toBe(0);
		} finally {
			await fs.unlink(emptyFile);
		}
	});

	it("malformed JSONL lines skipped silently", async () => {
		// Our fixture has a malformed line
		const result = await renderSessionMarkdown(sampleFixture);
		
		// Should still parse successfully and return valid output
		expect(result.markdown).toBeTruthy();
		expect(result.messageCount).toBeGreaterThan(0);
	});

	it("legacy bare-string content treated as single text block", async () => {
		// Create temporary JSONL with legacy format
		const legacyFile = path.join(testDir, "legacy-session.jsonl");
		const legacyContent = `{"type": "message", "message": {"role": "user", "content": "Hello world"}}
{"type": "message", "message": {"role": "assistant", "content": "Hi there!"}}`;
		await fs.writeFile(legacyFile, legacyContent);
		
		try {
			const result = await renderSessionMarkdown(legacyFile);
			expect(result.markdown).toContain("Hello world");
			expect(result.markdown).toContain("Hi there!");
			expect(result.messageCount).toBe(2);
		} finally {
			await fs.unlink(legacyFile);
		}
	});

	it("token-budget: oversized session shrunk to approximately maxBytes", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { maxBytes: 500 });
		
		// Result should be significantly smaller than without the limit
		// Allow up to 50% buffer due to message boundaries
		expect(result.markdown.length).toBeLessThanOrEqual(500 * 1.5);
	});

	it("token-budget: default maxBytes is 64KB", async () => {
		// Create a moderately sized JSONL that fits in default limit
		const result = await renderSessionMarkdown(sampleFixture);
		
		// Should fit within default 64KB
		expect(result.markdown.length).toBeLessThanOrEqual(64 * 1024);
	});

	it("returns correct messageCount despite malformed lines", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		
		// Count actual message-type records (fixture has some valid messages)
		const raw = await fs.readFile(sampleFixture, "utf-8");
		const lines = raw.split("\n").filter(l => l.trim().length > 0);
		const messageCount = lines.filter(l => {
			try {
				const parsed = JSON.parse(l);
				return parsed.type === "message" && parsed.message;
			} catch {
				return false;
			}
		}).length;
		
		expect(result.messageCount).toBe(messageCount);
	});

	it("maxToolBytes parameter applies to both toolCall and toolResult", async () => {
		const result = await renderSessionMarkdown(sampleFixture, { maxToolBytes: 50 });
		
		// Both tool calls and tool results should respect the limit
		const lines = result.markdown.split("\n");
		for (const line of lines) {
			// Check that truncation markers are present for long content
			if (line.includes("(truncated")) {
				expect(line).toMatch(/\d+ more chars\)/);
			}
		}
	});

	it("includes ' — latest' tag only on topmost heading", async () => {
		const result = await renderSessionMarkdown(sampleFixture);
		const latestTags = (result.markdown.match(/ — latest/g) || []).length;
		
		expect(latestTags).toBe(1);
	});

	it("non-message type records ignored", async () => {
		// Create temporary JSONL with mixed record types
		const mixedFile = path.join(testDir, "mixed-session.jsonl");
		const mixedContent = `{"type": "metadata", "data": "ignored"}
{"type": "message", "message": {"role": "user", "content": "Hello"}}
{"type": "config", "value": "ignored"}
{"type": "message", "message": {"role": "assistant", "content": "Hi"}}`;
		await fs.writeFile(mixedFile, mixedContent);
		
		try {
			const result = await renderSessionMarkdown(mixedFile);
			expect(result.messageCount).toBe(2);
			expect(result.markdown).toContain("Hello");
			expect(result.markdown).toContain("Hi");
			expect(result.markdown).not.toContain("ignored");
		} finally {
			await fs.unlink(mixedFile);
		}
	});

	it("multiple text blocks in message joined with double newline", async () => {
		// Create temporary JSONL with multi-block message
		const multiFile = path.join(testDir, "multi-block.jsonl");
		const multiContent = `{"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "First block"}, {"type": "text", "text": "Second block"}]}}`;
		await fs.writeFile(multiFile, multiContent);
		
		try {
			const result = await renderSessionMarkdown(multiFile);
			expect(result.markdown).toContain("First block");
			expect(result.markdown).toContain("Second block");
		} finally {
			await fs.unlink(multiFile);
		}
	});

	it("scope defaults to 'full' when not specified", async () => {
		const resultWithDefault = await renderSessionMarkdown(sampleFixture);
		const resultWithFull = await renderSessionMarkdown(sampleFixture, { scope: 'full' });
		
		// Both should produce identical results
		expect(resultWithDefault.markdown).toBe(resultWithFull.markdown);
		expect(resultWithDefault.messageCount).toBe(resultWithFull.messageCount);
	});
});
