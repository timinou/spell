import { createHash } from "node:crypto";
import type { SummarizeConfig } from "../config/types";

const SYSTEM_PROMPT = `You are summarizing a coding agent's chat session that has paused for user input.
Produce a 4-6 sentence "what's pending" recap. Lead with the decision the user
needs to make. Reference filenames or commands only when they're load-bearing.
No filler. Plain text, no markdown.`;

export type SummarizeResult =
	| { ok: true; tldr: string; cached: boolean }
	| {
			ok: false;
			reason: "threshold-not-met" | "http-error" | "timeout" | "no-config" | "parse-error";
			message: string;
	  };

export interface SummarizeRequest {
	markdown: string;
	messageCount: number;
	byteCount: number;
}

export class Summarizer {
	private config?: SummarizeConfig;
	private cache: Map<string, string>;
	private cacheCapacity: number;
	private timeoutMs: number;

	constructor(opts?: { config?: SummarizeConfig; cacheCapacity?: number; timeoutMs?: number }) {
		this.config = opts?.config;
		this.cache = new Map();
		this.cacheCapacity = opts?.cacheCapacity ?? 100;
		this.timeoutMs = opts?.timeoutMs ?? 15000;
	}

	shouldSummarize(req: SummarizeRequest): boolean {
		if (!this.config) {
			return false;
		}

		const { kind, threshold } = this.config.when;
		if (kind === "message-count") {
			return req.messageCount >= threshold;
		} else if (kind === "byte-count") {
			return req.byteCount >= threshold;
		}
		return false;
	}

	async summarize(req: SummarizeRequest): Promise<SummarizeResult> {
		if (!this.config) {
			return {
				ok: false,
				reason: "no-config",
				message: "No summarization config available",
			};
		}

		if (!this.shouldSummarize(req)) {
			return {
				ok: false,
				reason: "threshold-not-met",
				message: "Threshold not met for summarization",
			};
		}

		// Check cache
		const cacheKey = this.getCacheKey(req.markdown);
		const cached = this.cache.get(cacheKey);
		if (cached) {
			return { ok: true, tldr: cached, cached: true };
		}

		try {
			// POST to endpoint with timeout
			const controller = new AbortController();
			const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

			let response: Response;
			try {
				response = await fetch(this.config.endpoint, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${this.config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.config.model,
						messages: [
							{ role: "system", content: SYSTEM_PROMPT },
							{ role: "user", content: req.markdown },
						],
						max_tokens: this.config.maxTokens,
					}),
					signal: controller.signal,
				});
			} catch (err) {
				clearTimeout(timeoutHandle);
				if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
					return {
						ok: false,
						reason: "timeout",
						message: `Timeout after ${this.timeoutMs}ms`,
					};
				}
				return {
					ok: false,
					reason: "http-error",
					message: err instanceof Error ? err.message : String(err),
				};
			}

			clearTimeout(timeoutHandle);

			if (!response.ok) {
				return {
					ok: false,
					reason: "http-error",
					message: `HTTP ${response.status}: ${response.statusText}`,
				};
			}

			try {
 			const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
 			const tldr = data?.choices?.[0]?.message?.content;

				if (typeof tldr !== "string") {
					return {
						ok: false,
						reason: "parse-error",
						message: "Failed to extract tldr from response",
					};
				}

				// Cache the result
				if (this.cache.size >= this.cacheCapacity) {
					const firstKey = this.cache.keys().next().value;
					if (firstKey) {
						this.cache.delete(firstKey);
					}
				}
				this.cache.set(cacheKey, tldr);

				return { ok: true, tldr, cached: false };
			} catch (err) {
				return {
					ok: false,
					reason: "parse-error",
					message: err instanceof Error ? err.message : String(err),
				};
			}
		} catch (err) {
			return {
				ok: false,
				reason: "http-error",
				message: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private getCacheKey(markdown: string): string {
		return createHash("sha256").update(markdown).digest("hex");
	}
}
