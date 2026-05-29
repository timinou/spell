import type { Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";

export interface SpillBudget {
	maxBytes: number;
	maxLines: number;
}

export interface SpillPolicy {
	trigger: SpillBudget;
	success: SpillBudget;
	failure: SpillBudget;
}

export const LOW_SPILL_TRIGGER_LINES = 50;
export const LOW_SPILL_FAILURE_BYTES = 5 * 1024;
export const LOW_SPILL_FAILURE_LINES = 120;
export const LEGACY_SPILL_TRIGGER_BYTES = 50 * 1024;
export const LEGACY_WRAPPER_TAIL_BYTES = 20 * 1024;
export const LEGACY_WRAPPER_TAIL_LINES = 500;
export const LEGACY_STREAM_TAIL_BYTES = 50 * 1024;
export const UNBOUNDED_SPILL_LINES = Number.MAX_SAFE_INTEGER;

/**
 * Deterministic chars-per-token ratio used across the codebase
 * (see commit/map-reduce/utils.ts::estimateTokens and
 * session/compaction/compaction.ts::estimateTokens). Used to convert the
 * user-facing tools.getSpillThreshold (tokens) to bytes on the hot path
 * without a tokenizer dependency.
 */
export const TOKEN_BYTE_RATIO = 4;

const SPILL_SETTING_PATHS = [
	"tools.artifactSpillThreshold",
	"tools.artifactTailBytes",
	"tools.artifactTailLines",
] as const;

/**
 * Canonical name of the `get` tool. Routed to a dedicated policy in
 * resolveToolSpillPolicy and also listed in PRECISION_SPILL_EXEMPT_TOOLS
 * as a defensive fallback when callers bypass the dedicated route.
 */
export const GET_TOOL_NAME = "get";

export const PRECISION_SPILL_EXEMPT_TOOLS = new Set([
	"read",
	"grep",
	"org",
	"find",
	"code",
	"ast_grep",
	GET_TOOL_NAME,
]);

function getConfiguredSuccessBudget(settings: Settings | undefined): SpillBudget {
	return {
		maxBytes: (settings?.get("tools.artifactTailBytes") ?? getDefault("tools.artifactTailBytes")) * 1024,
		maxLines: settings?.get("tools.artifactTailLines") ?? getDefault("tools.artifactTailLines"),
	};
}

function getConfiguredTriggerBytes(settings: Settings | undefined): number {
	return (settings?.get("tools.artifactSpillThreshold") ?? getDefault("tools.artifactSpillThreshold")) * 1024;
}

function hasCustomSpillSettings(settings: Settings | undefined): boolean {
	if (!settings) return false;
	return SPILL_SETTING_PATHS.some(path => settings.get(path) !== getDefault(path));
}

export function getLowSpillPolicy(settings: Settings | undefined): SpillPolicy {
	const success = getConfiguredSuccessBudget(settings);
	return {
		trigger: { maxBytes: getConfiguredTriggerBytes(settings), maxLines: LOW_SPILL_TRIGGER_LINES },
		success,
		failure: {
			maxBytes: Math.max(success.maxBytes, LOW_SPILL_FAILURE_BYTES),
			maxLines: Math.max(success.maxLines, LOW_SPILL_FAILURE_LINES),
		},
	};
}

export function getLegacyWrapperSpillPolicy(): SpillPolicy {
	return {
		trigger: { maxBytes: LEGACY_SPILL_TRIGGER_BYTES, maxLines: UNBOUNDED_SPILL_LINES },
		success: { maxBytes: LEGACY_WRAPPER_TAIL_BYTES, maxLines: LEGACY_WRAPPER_TAIL_LINES },
		failure: { maxBytes: LEGACY_WRAPPER_TAIL_BYTES, maxLines: LEGACY_WRAPPER_TAIL_LINES },
	};
}

export function getLegacyStreamSpillPolicy(): SpillPolicy {
	return {
		trigger: { maxBytes: LEGACY_SPILL_TRIGGER_BYTES, maxLines: UNBOUNDED_SPILL_LINES },
		success: { maxBytes: LEGACY_STREAM_TAIL_BYTES, maxLines: UNBOUNDED_SPILL_LINES },
		failure: { maxBytes: LEGACY_STREAM_TAIL_BYTES, maxLines: UNBOUNDED_SPILL_LINES },
	};
}

/**
 * Dedicated policy for the `get` tool. Trigger and inline tail are both
 * sized to `tools.getSpillThreshold` (tokens × TOKEN_BYTE_RATIO bytes), so:
 *   - reads ≤ threshold → full inline, never spilled
 *   - reads > threshold → spill artifact + tail-mode inline up to threshold
 * Line-count caps are unbounded; `get` slices are explicit and the byte
 * cap is the single authoritative ceiling.
 */
export function getGetToolSpillPolicy(settings: Settings | undefined): SpillPolicy {
	const tokens = settings?.get("tools.getSpillThreshold") ?? getDefault("tools.getSpillThreshold");
	const maxBytes = tokens * TOKEN_BYTE_RATIO;
	const budget: SpillBudget = { maxBytes, maxLines: UNBOUNDED_SPILL_LINES };
	return {
		trigger: budget,
		success: budget,
		failure: budget,
	};
}

export function resolveToolSpillPolicy(
	options: { settings?: Settings; toolName?: string; lenient?: boolean } = {},
): SpillPolicy {
	if (options.lenient) {
		return getLegacyStreamSpillPolicy();
	}
	if (options.toolName === GET_TOOL_NAME) {
		return getGetToolSpillPolicy(options.settings);
	}
	if (
		options.toolName &&
		PRECISION_SPILL_EXEMPT_TOOLS.has(options.toolName) &&
		!hasCustomSpillSettings(options.settings)
	) {
		return getLegacyWrapperSpillPolicy();
	}
	return getLowSpillPolicy(options.settings);
}

export function getRetainedSpillBudget(policy: SpillPolicy): SpillBudget {
	return {
		maxBytes: Math.max(policy.success.maxBytes, policy.failure.maxBytes),
		maxLines: Math.max(policy.success.maxLines, policy.failure.maxLines),
	};
}

export function getInlineSpillBudget(policy: SpillPolicy, success: boolean): SpillBudget {
	return success ? policy.success : policy.failure;
}

export function countLogicalLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") lines += 1;
	}
	return lines;
}

export function shouldSpillText(text: string, policy: SpillPolicy): boolean {
	if (text.length === 0) return false;
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes > policy.trigger.maxBytes) return true;
	return countLogicalLines(text) > policy.trigger.maxLines;
}
