/**
 * Org integration for plan mode.
 *
 * Operations throw on failure; callers are responsible for surfacing errors.
 */
import {
	ACTIVE_STATES,
	appendToItemBodyInFile,
	BLOCKED_STATES,
	DEFAULT_ORG_CONFIG,
	extractIdLinks,
	findItemById,
	resolveCategories,
	TERMINAL_STATES,
	updateItemBodyInFile,
	updateItemStateInFile,
} from "@oh-my-pi/pi-org";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export interface OrgPlanRef {
	id: string;
	file: string;
}

/**
 * Build a minimal OrgConfig from the settings object. Mirrors the logic in
 * `src/tools/org.ts` `loadOrgConfig()` but without a full ToolSession.
 */
export function buildOrgConfig(settings: Settings) {
	const rawKeywords = settings.get("org.todoKeywords") as readonly string[] | string[] | undefined;
	const todoKeywords = rawKeywords && rawKeywords.length > 0 ? [...rawKeywords] : [...DEFAULT_ORG_CONFIG.todoKeywords];
	return { ...DEFAULT_ORG_CONFIG, todoKeywords };
}

/**
 * Mark an approved PLAN item as active by transitioning INIT -> DOING.
 *
 * Optionally prepends the first user message to the existing plan body.
 * Returns the plan item's CUSTOM_ID and planning transcript path on success,
 * or null when org is disabled.
 */
export interface ApprovePlanResult {
	id: string;
	transcriptPath?: string;
}

export async function approvePlanItem(
	settings: Settings,
	projectRoot: string,
	planItem: OrgPlanRef,
	initialMessage?: string,
): Promise<ApprovePlanResult | null> {
	if (!settings.get("org.enabled")) return null;

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(c => ({
		absPath: c.absPath,
		name: c.name,
		dir: c.dirName,
		prefix: c.prefix,
		root: projectRoot,
	}));
	const item = await findItemById(catDirs, planItem.id, config.todoKeywords);
	if (!item) {
		throw new Error(`Plan item "${planItem.id}" not found.`);
	}

	if (initialMessage?.trim()) {
		const prefixedBody = item.body?.trim()
			? `* Initial message\n\n${initialMessage}\n\n${item.body}`
			: `* Initial message\n\n${initialMessage}`;
		const bodyUpdated = await updateItemBodyInFile(planItem.file, planItem.id, prefixedBody, config.todoKeywords);
		if (!bodyUpdated) {
			throw new Error(
				`Failed to update body for plan item "${planItem.id}" (file: ${planItem.file}). Check logs for native error details.`,
			);
		}
	}

	const stateUpdated = await updateItemStateInFile(planItem.file, planItem.id, "DOING", config.todoKeywords);
	if (!stateUpdated) {
		throw new Error(
			`Failed to transition plan item "${planItem.id}" to DOING (file: ${planItem.file}). Check logs for native error details.`,
		);
	}

	// Extract planning transcript path from the org file's #+TRANSCRIPT_PATH keyword.
	// The value is stored as an org file link: [[file:/path/to/transcript.jsonl]]
	const rawTranscript = item.properties.TRANSCRIPT_PATH;
	const transcriptPath = rawTranscript?.match(/\[\[file:(.+?)\]\]/)?.[1];

	logger.debug("org-plan: approved plan", { planId: planItem.id, planFilePath: planItem.file });
	return { id: planItem.id, transcriptPath };
}

const COMPLETABLE_CHILD_STATES = new Set(["ITEM", ...ACTIVE_STATES]);

async function resolveItemLifecycleState(item: {
	state: string;
	file: string;
	properties?: Record<string, string>;
}): Promise<string> {
	if (item.state) return item.state;
	const propertyState = item.properties?.STATE;
	if (propertyState) return propertyState;
	const content = await Bun.file(item.file).text();
	return content.match(/^#\+STATE:\s*(\S+)/m)?.[1] ?? "";
}

export interface CompletePlanItemOptions {
	completionReport?: string;
}

export interface CompletePlanItemResult {
	planId: string;
	planFile: string;
	linkedChildIds: string[];
	completedChildIds: string[];
	skippedBlockedChildIds: string[];
	skippedDoneChildIds: string[];
	skippedOtherChildIds: string[];
}

/**
 * Complete a DOING PLAN item by reconciling linked child states, then transition PLAN to DONE.
 * Returns null when org is disabled.
 */
export async function completePlanItem(
	settings: Settings,
	projectRoot: string,
	planItem: OrgPlanRef,
	options?: CompletePlanItemOptions,
): Promise<CompletePlanItemResult | null> {
	if (!settings.get("org.enabled")) return null;

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(c => ({
		absPath: c.absPath,
		name: c.name,
		dir: c.dirName,
		prefix: c.prefix,
		root: projectRoot,
	}));
	const resolvedPlanItem = await findItemById(catDirs, planItem.id, config.todoKeywords);
	if (!resolvedPlanItem) {
		throw new Error(`Plan item "${planItem.id}" not found.`);
	}

	const planFilePath = resolvedPlanItem.file;
	const linkedChildIds = extractIdLinks(resolvedPlanItem.body ?? "");
	const childItems = await Promise.all(
		linkedChildIds.map(async childId => {
			const item = await findItemById(catDirs, childId, config.todoKeywords);
			if (!item) {
				throw new Error(`Linked child item "${childId}" from plan "${planItem.id}" was not found.`);
			}
			return item;
		}),
	);

	const completedChildIds: string[] = [];
	const skippedBlockedChildIds: string[] = [];
	const skippedDoneChildIds: string[] = [];
	const skippedOtherChildIds: string[] = [];

	for (const item of childItems) {
		const itemState = await resolveItemLifecycleState(item);
		if (BLOCKED_STATES.has(itemState)) {
			skippedBlockedChildIds.push(item.id);
			continue;
		}
		if (TERMINAL_STATES.has(itemState)) {
			skippedDoneChildIds.push(item.id);
			continue;
		}
		if (!COMPLETABLE_CHILD_STATES.has(itemState)) {
			skippedOtherChildIds.push(item.id);
			continue;
		}

		const childStateUpdated = await updateItemStateInFile(item.file, item.id, "DONE", config.todoKeywords);
		if (!childStateUpdated) {
			throw new Error(
				`Failed to transition child item "${item.id}" to DONE (file: ${item.file}). Check logs for native error details.`,
			);
		}
		completedChildIds.push(item.id);
	}

	const completionReport = options?.completionReport?.trim();
	if (completionReport) {
		const bodyAppended = await appendToItemBodyInFile(
			planFilePath,
			planItem.id,
			completionReport,
			config.todoKeywords,
		);
		if (!bodyAppended) {
			throw new Error(
				`Failed to append completion report for plan item "${planItem.id}" (file: ${planFilePath}). Check logs for native error details.`,
			);
		}
	}

	const planStateUpdated = await updateItemStateInFile(planFilePath, planItem.id, "DONE", config.todoKeywords);
	if (!planStateUpdated) {
		throw new Error(
			`Failed to transition plan item "${planItem.id}" to DONE (file: ${planFilePath}). Check logs for native error details.`,
		);
	}

	logger.debug("org-plan: completed plan", {
		planId: planItem.id,
		planFilePath,
		completedChildCount: completedChildIds.length,
		skippedBlockedChildCount: skippedBlockedChildIds.length,
		skippedDoneChildCount: skippedDoneChildIds.length,
		skippedOtherChildCount: skippedOtherChildIds.length,
	});

	return {
		planId: planItem.id,
		planFile: planFilePath,
		linkedChildIds,
		completedChildIds,
		skippedBlockedChildIds,
		skippedDoneChildIds,
		skippedOtherChildIds,
	};
}

/**
 * Resolve a plan item by its CUSTOM_ID across all configured categories.
 * Returns the item (with body) or null if not found / org disabled.
 */
export async function resolvePlanItem(
	settings: Settings,
	projectRoot: string,
	itemId: string,
): Promise<{ id: string; file: string; body: string; properties: Record<string, string> } | null> {
	if (!settings.get("org.enabled")) return null;

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(c => ({
		absPath: c.absPath,
		name: c.name,
		dir: c.dirName,
		prefix: c.prefix,
		root: projectRoot,
	}));

	const item = await findItemById(catDirs, itemId, config.todoKeywords);
	if (!item) return null;

	return { id: item.id, file: item.file, body: item.body ?? "", properties: item.properties ?? {} };
}
