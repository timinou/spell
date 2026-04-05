/**
 * Last-resort error handler for provider IIFE catch blocks.
 *
 * When a provider's error-handling code itself throws (e.g. `finalizeErrorMessage`
 * rejects, or `stream.push()` fails), this function creates a minimal error event
 * and attempts to push it. All errors are swallowed — this is the final defense
 * against unhandled rejections that crash the process.
 */
import type { Api, Model } from "../types";
import type { AssistantMessageEventStream } from "./event-stream";

export function pushFallbackError(stream: AssistantMessageEventStream, model: Model<Api>, error: unknown): void {
	try {
		const msg = error instanceof Error ? error.message : String(error);
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: `Provider error handling failed: ${msg}`,
				timestamp: Date.now(),
			},
		});
	} catch {
		/* truly nothing we can do */
	}
	try {
		stream.end();
	} catch {
		/* stream may already be ended */
	}
}
