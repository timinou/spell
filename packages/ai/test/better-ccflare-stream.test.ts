// pragma: allowlist secret
import { describe, expect, test } from "bun:test";
import { buildBetterCcflareHeaders, streamBetterCcflare } from "../src/providers/better-ccflare";

describe("buildBetterCcflareHeaders", () => {
	test("OAuth passthrough: no auth header when apiKey is empty", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "" });
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers.Authorization).toBeUndefined();
		expect(headers["User-Agent"]).toMatch(/^claude-cli\//);
	});

	test("OAuth passthrough: no auth header when apiKey is undefined-equivalent", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "" });
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers.Authorization).toBeUndefined();
	});

	test("API key auth: x-api-key header when apiKey is set (non-OAuth)", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "btr-test-key" });
		expect(headers["x-api-key"]).toBe("btr-test-key");
		expect(headers.Authorization).toBeUndefined();
	});

	test("API key auth: dummy-key (open access)", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "dummy-key" });
		expect(headers["x-api-key"]).toBe("dummy-key");
	});

	test("Stealth headers present", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "btr-test-key" });
		expect(headers["X-App"]).toBe("cli");
		expect(headers["Anthropic-Beta"]).toContain("claude-code-");
		expect(headers["Anthropic-Version"]).toBe("2023-06-01");
		expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
		expect(headers["User-Agent"]).toMatch(/^claude-cli\//);
		expect(headers["Content-Type"]).toBe("application/json");
	});

	test("Stealth headers present even in OAuth passthrough mode", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "" });
		expect(headers["X-App"]).toBe("cli");
		expect(headers["Anthropic-Beta"]).toContain("claude-code-");
	});

	test("stream mode sets text/event-stream Accept header", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "test", stream: true });
		expect(headers.Accept).toBe("text/event-stream");
	});

	test("non-stream mode sets application/json Accept header", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "test", stream: false });
		expect(headers.Accept).toBe("application/json");
	});

	test("modelHeaders with custom header pass through", () => {
		const headers = buildBetterCcflareHeaders({
			apiKey: "test", // pragma: allowlist secret
			modelHeaders: { "X-Custom": "value" },
		});
		expect(headers["X-Custom"]).toBe("value");
	});

	test("modelHeaders cannot override enforced headers", () => {
		const headers = buildBetterCcflareHeaders({
			apiKey: "test", // pragma: allowlist secret
			modelHeaders: { "x-api-key": "evil-key", "X-App": "evil" },
		});
		expect(headers["x-api-key"]).toBe("test");
		expect(headers["X-App"]).toBe("cli");
	});
});

describe("better-ccflare env-aware request construction", () => {
	test("defaults to OAuth passthrough when ANTHROPIC_AUTH_TOKEN is unset", () => {
		delete Bun.env.ANTHROPIC_AUTH_TOKEN;
		const headers = buildBetterCcflareHeaders({ apiKey: "" });
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers.Authorization).toBeUndefined();
	});

	test("uses x-api-key when ANTHROPIC_AUTH_TOKEN is a non-OAuth token", () => {
		const headers = buildBetterCcflareHeaders({ apiKey: "btr-my-real-key" });
		expect(headers["x-api-key"]).toBe("btr-my-real-key");
	});
});

describe("streamBetterCcflare URL construction", () => {
	test("constructs SDK client without /v1 suffix (SDK appends its own /v1/ prefix)", async () => {
		let resolvePath: (path: string) => void;
		const pathPromise = new Promise<string>(resolve => {
			resolvePath = resolve;
		});

		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const pathname = new URL(req.url).pathname;
				resolvePath(pathname);
				return new Response(JSON.stringify({ error: "test-server" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			},
		});

		try {
			Bun.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;

			const model: any = {
				id: "claude-sonnet-4-20250514",
				api: "anthropic-messages",
				provider: "better-ccflare",
				baseUrl: undefined,
				reasoning: true,
				input: ["text"],
				contextWindow: 200_000,
				maxTokens: 64_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const context: any = {
				system: "test",
				messages: [{ role: "user", content: "ping" }],
			};

			streamBetterCcflare(model, context, { apiKey: "btr-test-key" }); // pragma: allowlist secret

			const path = await pathPromise;
			expect(path).toBe("/v1/messages");
			expect(path).not.toBe("/v1/v1/messages");
		} finally {
			delete Bun.env.ANTHROPIC_BASE_URL;
			server.stop(true);
		}
	});
});
