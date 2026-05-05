// pragma: allowlist secret

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

	test("getEnvApiKey returns undefined when both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are unset", () => {
		delete Bun.env.ANTHROPIC_AUTH_TOKEN;
		delete Bun.env.ANTHROPIC_API_KEY;
		expect(getEnvApiKey("better-ccflare")).toBeUndefined();
	});

	test("getEnvApiKey returns undefined when only ANTHROPIC_API_KEY is set (no ANTHROPIC_AUTH_TOKEN)", () => {
		delete Bun.env.ANTHROPIC_AUTH_TOKEN;
		Bun.env.ANTHROPIC_API_KEY = "sk-ant-fallback-test-key"; // pragma: allowlist secret
		try {
			expect(getEnvApiKey("better-ccflare")).toBeUndefined();
		} finally {
			delete Bun.env.ANTHROPIC_API_KEY;
		}
	});

	test("getEnvApiKey prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY when both are set", () => {
		Bun.env.ANTHROPIC_AUTH_TOKEN = "btr-primary-key"; // pragma: allowlist secret
		Bun.env.ANTHROPIC_API_KEY = "sk-ant-secondary-key"; // pragma: allowlist secret
		try {
			expect(getEnvApiKey("better-ccflare")).toBe("btr-primary-key");
		} finally {
			delete Bun.env.ANTHROPIC_AUTH_TOKEN;
			delete Bun.env.ANTHROPIC_API_KEY;
		}
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
