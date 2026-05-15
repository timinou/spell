import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	GET_TOOL_NAME,
	getGetToolSpillPolicy,
	PRECISION_SPILL_EXEMPT_TOOLS,
	resolveToolSpillPolicy,
	shouldSpillText,
	TOKEN_BYTE_RATIO,
	UNBOUNDED_SPILL_LINES,
} from "../../src/session/spill-policy";

describe("get tool spill policy", () => {
	it("uses tools.getSpillThreshold (tokens) × TOKEN_BYTE_RATIO for trigger and tail", () => {
		const settings = Settings.isolated();
		settings.set("tools.getSpillThreshold", 25_000);

		const policy = getGetToolSpillPolicy(settings);
		const expectedBytes = 25_000 * TOKEN_BYTE_RATIO;

		expect(policy.trigger.maxBytes).toBe(expectedBytes);
		expect(policy.success.maxBytes).toBe(expectedBytes);
		expect(policy.failure.maxBytes).toBe(expectedBytes);
		expect(policy.trigger.maxLines).toBe(UNBOUNDED_SPILL_LINES);
		expect(policy.success.maxLines).toBe(UNBOUNDED_SPILL_LINES);
		expect(policy.failure.maxLines).toBe(UNBOUNDED_SPILL_LINES);
	});

	it("defaults to 25 000 tokens when settings is omitted", () => {
		const policy = getGetToolSpillPolicy(undefined);
		expect(policy.trigger.maxBytes).toBe(25_000 * TOKEN_BYTE_RATIO);
	});

	it("resolveToolSpillPolicy routes the get tool to the dedicated policy first", () => {
		const settings = Settings.isolated();
		settings.set("tools.getSpillThreshold", 10_000);

		const policy = resolveToolSpillPolicy({ settings, toolName: GET_TOOL_NAME });
		expect(policy.trigger.maxBytes).toBe(10_000 * TOKEN_BYTE_RATIO);
		expect(policy.trigger.maxLines).toBe(UNBOUNDED_SPILL_LINES);
	});

	it("dedicated get policy ignores tools.artifactSpillThreshold", () => {
		const settings = Settings.isolated();
		settings.set("tools.artifactSpillThreshold", 1); // 1 KB
		settings.set("tools.artifactTailLines", 10);

		const policy = resolveToolSpillPolicy({ settings, toolName: GET_TOOL_NAME });
		// Default 25 000 tokens still applies; artifact* settings do not bleed in.
		expect(policy.trigger.maxBytes).toBe(25_000 * TOKEN_BYTE_RATIO);
		expect(policy.trigger.maxLines).toBe(UNBOUNDED_SPILL_LINES);
	});

	it("get is also listed in PRECISION_SPILL_EXEMPT_TOOLS as defensive fallback", () => {
		expect(PRECISION_SPILL_EXEMPT_TOOLS.has(GET_TOOL_NAME)).toBe(true);
	});

	it("shouldSpillText agrees: 100 000 bytes stays inline at default 25k-token threshold", () => {
		const policy = getGetToolSpillPolicy(undefined);
		// 25_000 tokens × TOKEN_BYTE_RATIO (4) = 100 000 bytes (threshold).
		// shouldSpillText triggers on strictly greater than, so exactly-threshold stays inline.
		const text = "x".repeat(25_000 * TOKEN_BYTE_RATIO);
		expect(shouldSpillText(text, policy)).toBe(false);
	});

	it("shouldSpillText agrees: > 100 000 bytes spills at default 25k-token threshold", () => {
		const policy = getGetToolSpillPolicy(undefined);
		const text = "x".repeat(25_000 * TOKEN_BYTE_RATIO + 1);
		expect(shouldSpillText(text, policy)).toBe(true);
	});

	it("shouldSpillText ignores line count for the get policy (UNBOUNDED_SPILL_LINES)", () => {
		const policy = getGetToolSpillPolicy(undefined);
		// 25 000 single-char + newline lines = 50 000 bytes — well under 100 000 byte cap.
		const text = "a\n".repeat(25_000);
		expect(shouldSpillText(text, policy)).toBe(false);
	});
});
