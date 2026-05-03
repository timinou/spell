import { describe, expect, test } from "bun:test";
import { getBundledModel, getBundledProviders } from "../src/models";

describe("better-ccflare model registry", () => {
	test("getBundledModel returns claude-opus-4-7 with correct provider", () => {
		const model = getBundledModel("better-ccflare", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("better-ccflare");
		expect(model!.api).toBe("anthropic-messages");
		expect(model!.baseUrl).toBe("http://localhost:8080");
	});

	test("getBundledModel returns claude-sonnet-4-20250514", () => {
		const model = getBundledModel("better-ccflare", "claude-sonnet-4-20250514");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("better-ccflare");
		expect(model!.api).toBe("anthropic-messages");
	});

	test("getBundledModel returns claude-sonnet-4-5-20250929", () => {
		const model = getBundledModel("better-ccflare", "claude-sonnet-4-5-20250929");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("better-ccflare");
		expect(model!.api).toBe("anthropic-messages");
	});

	test("getBundledModel returns claude-haiku-4-5-20251001", () => {
		const model = getBundledModel("better-ccflare", "claude-haiku-4-5-20251001");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("better-ccflare");
		expect(model!.baseUrl).toBe("http://localhost:8080");
	});

	test("getBundledProviders includes better-ccflare", () => {
		const providers = getBundledProviders();
		expect(providers).toContain("better-ccflare");
	});

	test("getBundledModel returns undefined for unknown model", () => {
		const model = getBundledModel("better-ccflare", "nonexistent-model");
		expect(model).toBeUndefined();
	});
});
