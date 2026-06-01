import { logger } from "@spell/pi-utils";
import type { GoalResult } from "../executor/types";
import type { WebhookHook } from "../manifest/types";
import type { HookContext, HookExecutor } from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;
const TEMPLATE_PATTERN = /\{\{(\w+)\}\}/g;

interface WebhookPayload {
	goalName: string;
	status: GoalResult["status"];
	summary?: string;
	error?: string;
	duration: number;
	date: string;
}

const WEBHOOK_TIMEOUT = Symbol("webhook-timeout");

export class WebhookHookExecutor implements HookExecutor {
	async execute(target: WebhookHook, result: GoalResult, context: HookContext): Promise<void> {
		const controller = new AbortController();
		const url = this.#substituteTemplate(target.url, result, context);
		const method = target.method ?? "POST";
		let didTimeout = false;
		const timeout = setTimeout(() => {
			didTimeout = true;
			controller.abort();
		}, DEFAULT_TIMEOUT_MS);

		const request = fetch(url, {
			method,
			headers: method === "POST" ? { "content-type": "application/json" } : undefined,
			body: method === "POST" ? JSON.stringify(this.#createPayload(result, context)) : undefined,
			signal: controller.signal,
		}).catch(error => {
			if (didTimeout) {
				return WEBHOOK_TIMEOUT;
			}
			throw error;
		});

		const timeoutSignal = new Promise<Response | typeof WEBHOOK_TIMEOUT>(resolve => {
			setTimeout(() => resolve(WEBHOOK_TIMEOUT), DEFAULT_TIMEOUT_MS);
		});

		try {
			const response = await Promise.race([request, timeoutSignal]);
			if (response === WEBHOOK_TIMEOUT) {
				logger.warn("Webhook hook request timed out", { url, timeoutMs: DEFAULT_TIMEOUT_MS });
				return;
			}
			const settledResponse = response as Response;
			if (!settledResponse.ok) {
				logger.warn("Webhook hook responded with non-2xx status", {
					url,
					status: settledResponse.status,
					statusText: settledResponse.statusText,
				});
			}
		} catch (error) {
			logger.warn("Webhook hook request failed", {
				url,
				error: String(error),
			});
		} finally {
			clearTimeout(timeout);
		}
	}

	#createPayload(result: GoalResult, context: HookContext): WebhookPayload {
		return {
			goalName: context.goalName,
			status: result.status,
			summary: result.summary,
			error: result.error,
			duration: result.duration,
			date: context.timestamp.toISOString(),
		};
	}

	#substituteTemplate(template: string, result: GoalResult, context: HookContext): string {
		const values: Record<string, string> = {
			status: result.status,
			goalName: context.goalName,
			summary: result.summary ?? "",
			duration: String(result.duration),
			date: context.timestamp.toISOString(),
		};
		return template.replace(TEMPLATE_PATTERN, (match, name: string) => values[name] ?? match);
	}
}
