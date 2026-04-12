import { $env } from "@oh-my-pi/pi-utils";

const DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS = 45_000;

export function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * Set `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getOpenAIStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS, DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS);
}

const DEFAULT_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Returns the idle timeout used for Anthropic streaming transports.
 *
 * Set `PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getAnthropicStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS, DEFAULT_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS);
}
const DEFAULT_BEDROCK_STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Returns the idle timeout used for Bedrock streaming transports.
 *
 * Set `PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getBedrockStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS, DEFAULT_BEDROCK_STREAM_IDLE_TIMEOUT_MS);
}

const DEFAULT_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/**
 * Returns the idle timeout used while a provider is actively streaming tool arguments.
 *
 * Set `PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS=0` to disable the extended watchdog.
 */
export function getToolArgumentStreamIdleTimeoutMs(baseIdleTimeoutMs?: number): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS,
		Math.max(baseIdleTimeoutMs ?? 0, DEFAULT_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS),
	);
}

export interface IdleTimeoutIteratorOptions {
	idleTimeoutMs?: number;
	getIdleTimeoutMs?: () => number | undefined;
	errorMessage: string;
	onIdle?: () => void;
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap between items.
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();

	while (true) {
		const idleTimeoutMs = options.getIdleTimeoutMs?.() ?? options.idleTimeoutMs;
		const nextResultPromise = iterator.next().then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

		let timeoutPromise: Promise<{ kind: "timeout" }> | undefined;
		let timer: NodeJS.Timeout | undefined;
		if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
			const timeoutResult = Promise.withResolvers<{ kind: "timeout" }>();
			timeoutPromise = timeoutResult.promise;
			timer = setTimeout(() => timeoutResult.resolve({ kind: "timeout" }), idleTimeoutMs);
		}

		try {
			const outcome = timeoutPromise
				? await Promise.race([nextResultPromise, timeoutPromise])
				: await nextResultPromise;
			if (outcome.kind === "timeout") {
				options.onIdle?.();
				const returnPromise = iterator.return?.();
				if (returnPromise) {
					void returnPromise.catch(() => {});
				}
				throw new Error(options.errorMessage);
			}
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				return;
			}
			yield outcome.result.value;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
