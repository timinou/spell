import { describe, expect, test } from "bun:test";
import type { SystemPromptBlock } from "../src/types";
import { resolveOpenAICacheParams, systemPromptBlocks, systemPromptStablePrefix, systemPromptText } from "../src/utils";

describe("systemPromptText", () => {
	test("returns string input as-is", () => {
		expect(systemPromptText("Hello world")).toBe("Hello world");
	});

	test("joins blocks with newline", () => {
		const blocks: SystemPromptBlock[] = [{ text: "block1", stable: true }, { text: "block2" }];
		expect(systemPromptText(blocks)).toBe("block1\nblock2");
	});

	test("returns undefined for undefined input", () => {
		expect(systemPromptText(undefined)).toBeUndefined();
	});

	test("returns undefined for empty array", () => {
		expect(systemPromptText([])).toBeUndefined();
	});
});

describe("systemPromptBlocks", () => {
	test("normalizes string to single stable block", () => {
		expect(systemPromptBlocks("Hello")).toEqual([{ text: "Hello", stable: true }]);
	});

	test("passes array through unchanged", () => {
		const blocks: SystemPromptBlock[] = [{ text: "a" }, { text: "b", stable: false }];
		expect(systemPromptBlocks(blocks)).toBe(blocks);
	});

	test("returns empty array for undefined", () => {
		expect(systemPromptBlocks(undefined)).toEqual([]);
	});

	test("returns empty array for empty string", () => {
		expect(systemPromptBlocks("")).toEqual([]);
	});
});

describe("systemPromptStablePrefix", () => {
	test("filters to stable blocks only", () => {
		const blocks: SystemPromptBlock[] = [
			{ text: "stable1", stable: true },
			{ text: "dynamic", stable: false },
			{ text: "stable2" }, // absent stable defaults to included
		];
		expect(systemPromptStablePrefix(blocks)).toBe("stable1\nstable2");
	});

	test("treats plain string as stable", () => {
		expect(systemPromptStablePrefix("all stable")).toBe("all stable");
	});

	test("returns undefined when all blocks are unstable", () => {
		const blocks: SystemPromptBlock[] = [{ text: "dynamic", stable: false }];
		expect(systemPromptStablePrefix(blocks)).toBeUndefined();
	});

	test("returns undefined for undefined input", () => {
		expect(systemPromptStablePrefix(undefined)).toBeUndefined();
	});
});

describe("resolveOpenAICacheParams", () => {
	test("stable prompt hash used as cache key", () => {
		const result = resolveOpenAICacheParams("long", "session-123", [
			{ text: "stable content", stable: true },
			{ text: "dynamic content", stable: false },
		]);
		expect(result.prompt_cache_key).toBe(Bun.hash("stable content").toString(16));
		expect(result.prompt_cache_retention).toBe("24h");
	});

	test("same stable content yields same key across sessions", () => {
		const key1 = resolveOpenAICacheParams("long", "session-A", [{ text: "same prompt", stable: true }]);
		const key2 = resolveOpenAICacheParams("long", "session-B", [{ text: "same prompt", stable: true }]);
		expect(key1.prompt_cache_key).toBe(key2.prompt_cache_key);
	});

	test("no stable blocks falls back to sessionId", () => {
		const result = resolveOpenAICacheParams("long", "session-123", [{ text: "all dynamic", stable: false }]);
		expect(result.prompt_cache_key).toBe("session-123");
	});

	test("string systemPrompt treated as stable", () => {
		const result = resolveOpenAICacheParams("long", "session-123", "hello world");
		expect(result.prompt_cache_key).toBe(Bun.hash("hello world").toString(16));
	});

	test("undefined systemPrompt falls back to sessionId", () => {
		const result = resolveOpenAICacheParams("long", "session-123");
		expect(result.prompt_cache_key).toBe("session-123");
	});

	test("retention none returns empty regardless of prompt", () => {
		const result = resolveOpenAICacheParams("none", "session-123", "some prompt");
		expect(result).toEqual({});
	});
});
