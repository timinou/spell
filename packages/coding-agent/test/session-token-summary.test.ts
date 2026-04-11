import { describe, expect, test } from "bun:test";
import {
	formatExitTokenSummary,
	formatSubtaskExitSummary,
	formatTokenCount,
} from "@oh-my-pi/pi-coding-agent/session/token-summary";

describe("formatTokenCount", () => {
	test("formats zero", () => {
		expect(formatTokenCount(0)).toBe("0");
	});

	test("formats small numbers exactly", () => {
		expect(formatTokenCount(132)).toBe("132");
		expect(formatTokenCount(999)).toBe("999");
	});

	test("formats thousands with K suffix", () => {
		expect(formatTokenCount(1000)).toBe("1K");
		expect(formatTokenCount(45000)).toBe("45K");
	});

	test("formats thousands with decimal", () => {
		expect(formatTokenCount(1300)).toBe("1.3K");
		expect(formatTokenCount(45100)).toBe("45.1K");
	});

	test("formats millions with M suffix", () => {
		expect(formatTokenCount(1_000_000)).toBe("1M");
		expect(formatTokenCount(1_332_246)).toBe("1.3M");
		expect(formatTokenCount(13_700_000)).toBe("13.7M");
	});

	test("treats negative numbers as zero", () => {
		expect(formatTokenCount(-500)).toBe("0");
	});

	test("handles very large numbers with M suffix", () => {
		expect(formatTokenCount(1_500_000_000)).toBe("1500M");
	});
});

describe("formatExitTokenSummary", () => {
	test("shows all non-zero categories", () => {
		const result = formatExitTokenSummary({
			input: 45_000,
			output: 12_000,
			thinking: 8_000,
			cacheRead: 120_000,
			cost: 0.42,
		});
		expect(result).toContain("45K in");
		expect(result).toContain("12K out");
		expect(result).toContain("8K think");
		expect(result).toContain("120K cache");
		expect(result).toContain("$0.42");
	});

	test("omits zero categories", () => {
		const result = formatExitTokenSummary({
			input: 45_000,
			output: 12_000,
			thinking: 0,
			cacheRead: 0,
			cost: 0.1,
		});
		expect(result).not.toContain("think");
		expect(result).not.toContain("cache");
		expect(result).toContain("$0.10");
	});

	test("includes memory line when present", () => {
		const result = formatExitTokenSummary({
			input: 1_000,
			output: 500,
			thinking: 0,
			cacheRead: 0,
			cost: 0.01,
			memoryTokens: 1_300_000,
		});
		expect(result).toContain("mem: 1.3M");
	});

	test("handles all zeros", () => {
		const result = formatExitTokenSummary({
			input: 0,
			output: 0,
			thinking: 0,
			cacheRead: 0,
			cost: 0,
		});
		expect(result).toContain("no tokens recorded");
	});

	test("formats cost with two decimal places", () => {
		const result = formatExitTokenSummary({
			input: 1_000,
			output: 0,
			thinking: 0,
			cacheRead: 0,
			cost: 1,
		});
		expect(result).toContain("$1.00");
	});
});

describe("formatSubtaskExitSummary", () => {
	test("formats aggregate subtask usage", () => {
		const result = formatSubtaskExitSummary({
			totalLaunched: 8,
			totalTokens: 320_000,
			totalCost: 1.23,
			avgTokensPerSubtask: 40_000,
			cacheHitRate: 0.72,
		});
		expect(result).toContain("8 launched");
		expect(result).toContain("320K tokens");
		expect(result).toContain("$1.23");
		expect(result).toContain("40K avg/task");
		expect(result).toContain("72% cache");
	});

	test("returns null when no subtasks were launched", () => {
		expect(
			formatSubtaskExitSummary({
				totalLaunched: 0,
				totalTokens: 0,
				totalCost: 0,
				avgTokensPerSubtask: 0,
				cacheHitRate: 0,
			}),
		).toBeNull();
	});
});
