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

const SPILL_SETTING_PATHS = [
	"tools.artifactSpillThreshold",
	"tools.artifactTailBytes",
	"tools.artifactTailLines",
] as const;

export const PRECISION_SPILL_EXEMPT_TOOLS = new Set([
	"read",
	"grep",
	"org",
	"find",
	"code",
	"lsp",
	"ast_grep",
	"ast_edit",
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

export function resolveToolSpillPolicy(
	options: { settings?: Settings; toolName?: string; lenient?: boolean } = {},
): SpillPolicy {
	if (options.lenient) {
		return getLegacyStreamSpillPolicy();
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
