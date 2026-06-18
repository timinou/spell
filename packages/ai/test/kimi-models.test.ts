import { describe, expect, it } from "bun:test";
import { Effort, getSupportedEfforts } from "../src/model-thinking";
import { getBundledModel } from "../src/models";

describe("Kimi bundled models", () => {
	const providers = [
		{ provider: "kimi-code", baseUrl: "https://api.kimi.com/coding/v1" },
		{ provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1" },
	] as const;

	const variants = [
		{
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 },
		},
		{
			id: "kimi-k2.7-code-highspeed",
			name: "Kimi K2.7 Code HighSpeed",
			cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 },
		},
	] as const;

	it("includes K2.7 Code variants for Kimi API providers", () => {
		for (const { provider, baseUrl } of providers) {
			for (const variant of variants) {
				const model = getBundledModel(provider, variant.id);

				expect(model.id).toBe(variant.id);
				expect(model.name).toBe(variant.name);
				expect(model.provider).toBe(provider);
				expect(model.baseUrl).toBe(baseUrl);
				expect(model.api).toBe("openai-completions");
				expect(model.reasoning).toBe(true);
				expect(model.input).toEqual(["text", "image"]);
				expect(model.contextWindow).toBe(262144);
				expect(model.maxTokens).toBe(65536);
				expect(model.cost).toEqual(variant.cost);
				expect(getSupportedEfforts(model)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
			}
		}
	});
});
