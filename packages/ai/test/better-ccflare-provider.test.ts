import { describe, expect, test } from "bun:test";
import { resolveAnthropicBaseUrl } from "../src/providers/anthropic";
import { getEnvApiKey } from "../src/stream";
import type { Model } from "../src/types";

function makeBetterCcflareModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-20250514",
		name: "Test",
		api: "anthropic-messages",
		provider: "better-ccflare",
		baseUrl: undefined as unknown as string,
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 64000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

describe("better-ccflare env var resolution", () => {
	test("getEnvApiKey returns ANTHROPIC_AUTH_TOKEN when set", () => {
		Bun.env.ANTHROPIC_AUTH_TOKEN = "test-key";
		try {
			expect(getEnvApiKey("better-ccflare")).toBe("test-key");
		} finally {
			delete Bun.env.ANTHROPIC_AUTH_TOKEN;
		}
	});

	test("getEnvApiKey returns undefined when ANTHROPIC_AUTH_TOKEN is unset", () => {
		delete Bun.env.ANTHROPIC_AUTH_TOKEN;
		expect(getEnvApiKey("better-ccflare")).toBeUndefined();
	});

	test("resolveAnthropicBaseUrl returns ANTHROPIC_BASE_URL when set", () => {
		Bun.env.ANTHROPIC_BASE_URL = "http://localhost:9999";
		try {
			const model = makeBetterCcflareModel();
			expect(resolveAnthropicBaseUrl(model)).toBe("http://localhost:9999");
		} finally {
			delete Bun.env.ANTHROPIC_BASE_URL;
		}
	});

	test("resolveAnthropicBaseUrl returns model.baseUrl when set (KDL wins)", () => {
		Bun.env.ANTHROPIC_BASE_URL = "http://localhost:9999";
		try {
			const model = makeBetterCcflareModel({ baseUrl: "http://custom:3000" });
			expect(resolveAnthropicBaseUrl(model)).toBe("http://custom:3000");
		} finally {
			delete Bun.env.ANTHROPIC_BASE_URL;
		}
	});

	test("resolveAnthropicBaseUrl defaults to http://localhost:8080", () => {
		delete Bun.env.ANTHROPIC_BASE_URL;
		const model = makeBetterCcflareModel();
		expect(resolveAnthropicBaseUrl(model)).toBe("http://localhost:8080");
	});
});
