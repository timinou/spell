import { $env } from "@oh-my-pi/pi-utils";
import type {
	CacheRetention,
	OpenAIResponsesHistoryPayload,
	ProviderPayload,
	SystemPrompt,
	SystemPromptBlock,
} from "./types";

export { isRecord } from "@oh-my-pi/pi-utils";

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

export function normalizeResponsesToolCallId(id: string): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		const normalizedCallId = truncateResponseItemId(callId, getIdPrefix(callId, "call"));
		const normalizedItemId = normalizeResponsesItemId(itemId);
		return { callId: normalizedCallId, itemId: normalizedItemId };
	}
	const hash = Bun.hash.xxHash64(id).toString(36);
	const normalizedCallId = id.startsWith("call_") ? truncateResponseItemId(id, "call") : `call_${hash}`;
	return { callId: normalizedCallId, itemId: `fc_${hash}` };
}

function getIdPrefix(id: string, fallback: string): string {
	const prefix = id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
	return prefix || fallback;
}

function normalizeResponsesItemId(itemId: string): string {
	const prefix = getIdPrefix(itemId, "fc");
	if (prefix !== "fc" && prefix !== "fcr") {
		return `fc_${Bun.hash.xxHash64(itemId).toString(36)}`;
	}
	return truncateResponseItemId(itemId, prefix);
}

/**
 * Truncate an OpenAI Responses API item ID to 64 characters.
 * IDs exceeding the limit are replaced with a hash-based ID using the given prefix.
 */
export function truncateResponseItemId(id: string, prefix: string): string {
	if (id.length <= 64) return id;
	return `${prefix}_${Bun.hash.xxHash64(id).toString(36)}`;
}

export function createOpenAIResponsesHistoryPayload(
	provider: string,
	items: Array<Record<string, unknown>>,
	incremental = true,
): OpenAIResponsesHistoryPayload {
	return {
		type: "openaiResponsesHistory",
		provider,
		...(incremental ? { dt: true } : {}),
		items,
	};
}

export function getOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): OpenAIResponsesHistoryPayload | undefined {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return undefined;
	}
	const payloadProvider = providerPayload.provider ?? fallbackProvider;
	if (!payloadProvider || payloadProvider !== currentProvider) {
		return undefined;
	}
	return { ...providerPayload, provider: payloadProvider };
}

export function getOpenAIResponsesHistoryItems(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): Array<Record<string, unknown>> | undefined {
	return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider)?.items;
}

/**
 * Resolve cache retention preference.
 * Defaults to "long" and uses PI_CACHE_RETENTION for backward compatibility.
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if ($env.PI_CACHE_RETENTION === "short") return "short";
	if ($env.PI_CACHE_RETENTION === "none") return "none";
	return "long";
}

export interface OpenAICacheParams {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h";
}

/**
 * Resolve OpenAI-family prompt cache parameters from retention preference.
 * Derives cache key from stable prompt content when available for cross-session reuse.
 * Maps "long" to 24h extended retention, "short" to in-memory (server default).
 */
export function resolveOpenAICacheParams(
	cacheRetention: CacheRetention | undefined,
	sessionId: string | undefined,
	systemPrompt?: SystemPrompt,
): OpenAICacheParams {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") return {};

	let cacheKey: string | undefined;
	const stableText = systemPromptStablePrefix(systemPrompt);
	if (stableText) {
		cacheKey = Bun.hash(stableText).toString(16);
	} else if (sessionId) {
		cacheKey = sessionId;
	}

	if (!cacheKey) return {};

	return {
		prompt_cache_key: cacheKey,
		prompt_cache_retention: retention === "long" ? "24h" : undefined,
	};
}

/** Join system prompt blocks into a single string. */
export function systemPromptText(sp: SystemPrompt | undefined): string | undefined {
	if (sp == null) return undefined;
	if (typeof sp === "string") return sp;
	if (sp.length === 0) return undefined;
	return sp.map(b => b.text).join("\n");
}

/** Normalize a system prompt to block array. A plain string becomes a single stable block. */
export function systemPromptBlocks(sp: SystemPrompt | undefined): SystemPromptBlock[] {
	if (sp == null) return [];
	if (typeof sp === "string") return sp.length > 0 ? [{ text: sp, stable: true }] : [];
	return sp;
}

/** Extract the text of stable blocks only, joined. Returns undefined if no stable blocks. */
export function systemPromptStablePrefix(sp: SystemPrompt | undefined): string | undefined {
	const blocks = systemPromptBlocks(sp);
	const stable = blocks.filter(b => b.stable !== false);
	if (stable.length === 0) return undefined;
	return stable.map(b => b.text).join("\n");
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}
