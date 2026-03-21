/**
 * Org integration for plan mode.
 *
 * Operations throw on failure; callers are responsible for surfacing errors.
 */
import {
	DEFAULT_ORG_CONFIG,
	findItemById,
	resolveCategories,
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
 * Returns the plan item's CUSTOM_ID on success, or null when org is disabled.
 */
export async function approvePlanItem(
	settings: Settings,
	projectRoot: string,
	planItem: OrgPlanRef,
	initialMessage?: string,
): Promise<string | null> {
	if (!settings.get("org.enabled")) return null;

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName }));
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
			throw new Error(`Failed to update body for plan item "${planItem.id}".`);
		}
	}

	const stateUpdated = await updateItemStateInFile(planItem.file, planItem.id, "DOING", config.todoKeywords);
	if (!stateUpdated) {
		throw new Error(`Failed to transition plan item "${planItem.id}" to DOING.`);
	}

	logger.debug("org-plan: approved plan", { planId: planItem.id, planFilePath: planItem.file });
	return planItem.id;
}

/**
 * Resolve a plan item by its CUSTOM_ID across all configured categories.
 * Returns the item (with body) or null if not found / org disabled.
 */
export async function resolvePlanItem(
	settings: Settings,
	projectRoot: string,
	itemId: string,
): Promise<{ id: string; file: string; body: string } | null> {
	if (!settings.get("org.enabled")) return null;

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName }));

	const item = await findItemById(catDirs, itemId, config.todoKeywords);
	if (!item) return null;

	return { id: item.id, file: item.file, body: item.body ?? "" };
}
