import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";

describe("bundled Claude Opus 4.7 metadata", () => {
	it("includes the Anthropic Claude Opus 4.7 model with expected limits", () => {
		const model = getBundledModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(model?.name).toBe("Claude Opus 4.7");
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(model?.cost).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(model?.thinking).toMatchObject({
			mode: "anthropic-adaptive",
			minLevel: "minimal",
			maxLevel: "xhigh",
		});
	});
});
