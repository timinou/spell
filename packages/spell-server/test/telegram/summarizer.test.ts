import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Summarizer } from "../../src/telegram/summarizer";
import type { SummarizeConfig } from "../../src/config/types";

describe("Summarizer", () => {
	describe("shouldSummarize", () => {
		it("returns false when no config provided", () => {
			const summarizer = new Summarizer();
			const result = summarizer.shouldSummarize({
				markdown: "test",
				messageCount: 50,
				byteCount: 1000,
			});
			expect(result).toBe(false);
		});

		it("returns false when messageCount < threshold", () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });
			const result = summarizer.shouldSummarize({
				markdown: "test",
				messageCount: 25,
				byteCount: 1000,
			});
			expect(result).toBe(false);
		});

		it("returns true when messageCount >= threshold", () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });
			const result = summarizer.shouldSummarize({
				markdown: "test",
				messageCount: 30,
				byteCount: 1000,
			});
			expect(result).toBe(true);
		});

		it("returns true when byteCount >= threshold (byte-count kind)", () => {
			const config: SummarizeConfig = {
				when: { kind: "byte-count", threshold: 500 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });
			const result = summarizer.shouldSummarize({
				markdown: "test",
				messageCount: 10,
				byteCount: 500,
			});
			expect(result).toBe(true);
		});

		it("returns false when byteCount < threshold (byte-count kind)", () => {
			const config: SummarizeConfig = {
				when: { kind: "byte-count", threshold: 500 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });
			const result = summarizer.shouldSummarize({
				markdown: "test",
				messageCount: 10,
				byteCount: 400,
			});
			expect(result).toBe(false);
		});
	});

	describe("summarize", () => {
		let originalFetch: typeof globalThis.fetch;

		beforeEach(() => {
			originalFetch = globalThis.fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it("returns threshold-not-met when threshold not met", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });
			const result = await summarizer.summarize({
				markdown: "test",
				messageCount: 25,
				byteCount: 1000,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("threshold-not-met");
		});

		it("returns no-config when no config provided", async () => {
			const summarizer = new Summarizer();
			const result = await summarizer.summarize({
				markdown: "test",
				messageCount: 50,
				byteCount: 1000,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("no-config");
		});

		it("successfully summarizes with HTTP POST", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com/chat/completions",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });

			let capturedRequest: RequestInit | undefined;
			globalThis.fetch = (async (url: string | Request | URL, options?: RequestInit) => {
				capturedRequest = options;
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: "Test summary of the session",
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
   }) as unknown as typeof fetch;

			const result = await summarizer.summarize({
				markdown: "# Session\n\nThis is a test",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.tldr).toBe("Test summary of the session");
				expect(result.cached).toBe(false);
			}

			// Verify the request was correct
			expect(capturedRequest?.headers).toMatchObject({
				Authorization: "Bearer test-key",
				"Content-Type": "application/json",
			});
		});

		it("returns http-error on non-200 response", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });

			globalThis.fetch = (async () => {
				return new Response("Server error", { status: 500 });
   }) as unknown as typeof fetch;

			const result = await summarizer.summarize({
				markdown: "test",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("http-error");
		});

		it("returns timeout error when fetch exceeds timeout", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config, timeoutMs: 50 });

			globalThis.fetch = (async (url: string | Request | URL, options?: RequestInit) => {
				const signal = (options as any)?.signal;
				return new Promise((resolve, reject) => {
					// Check if signal is already aborted
					if (signal?.aborted) {
						reject(new Error("Request aborted"));
						return;
					}
					// Listen for abort event
					signal?.addEventListener("abort", () => {
						reject(new Error("The operation was aborted"));
					});
					// Never resolve - let the timeout trigger the abort
				});
   }) as unknown as typeof fetch;

			const result = await summarizer.summarize({
				markdown: "test",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("timeout");
		});

		it("returns parse-error when response is missing content", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });

			globalThis.fetch = (async () => {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: undefined,
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
   }) as unknown as typeof fetch;

			const result = await summarizer.summarize({
				markdown: "test",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("parse-error");
		});

		it("caches results and returns cached: true on second call", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });

			let callCount = 0;
			globalThis.fetch = (async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: "Cached summary",
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
   }) as unknown as typeof fetch;

			// First call
			const result1 = await summarizer.summarize({
				markdown: "test content",
				messageCount: 35,
				byteCount: 2000,
			});

			// Second call with same markdown
			const result2 = await summarizer.summarize({
				markdown: "test content",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result1.ok).toBe(true);
			expect(result2.ok).toBe(true);

			if (result1.ok && result2.ok) {
				expect(result1.cached).toBe(false);
				expect(result2.cached).toBe(true);
				expect(result1.tldr).toBe(result2.tldr);
			}

			// Fetch should only be called once
			expect(callCount).toBe(1);
		});

		it("cache miss for different markdown content", async () => {
			const config: SummarizeConfig = {
				when: { kind: "message-count", threshold: 30 },
				model: "test-model",
				endpoint: "https://test.com",
				apiKey: "test-key",
				maxTokens: 250,
				promptStyle: "needs-input-recap",
			};
			const summarizer = new Summarizer({ config });

			let callCount = 0;
			globalThis.fetch = (async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: `Summary ${callCount}`,
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
   }) as unknown as typeof fetch;

			// First call
			const result1 = await summarizer.summarize({
				markdown: "test content 1",
				messageCount: 35,
				byteCount: 2000,
			});

			// Second call with different markdown
			const result2 = await summarizer.summarize({
				markdown: "test content 2",
				messageCount: 35,
				byteCount: 2000,
			});

			expect(result1.ok).toBe(true);
			expect(result2.ok).toBe(true);

			if (result1.ok && result2.ok) {
				expect(result1.cached).toBe(false);
				expect(result2.cached).toBe(false);
				expect(result1.tldr).toBe("Summary 1");
				expect(result2.tldr).toBe("Summary 2");
			}

			// Fetch should be called twice
			expect(callCount).toBe(2);
		});
	});
});
