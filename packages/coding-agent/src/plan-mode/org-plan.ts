/**
 * Org integration for plan mode.
 *
 * On plan approval: the draft item is marked DONE and a new active item is
 * created in the configured active category with the plan content as body.
 *
 * Operations throw on failure; callers are responsible for surfacing errors.
 */

import * as path from "node:path";
import {
	appendItemToFile,
	DEFAULT_ORG_CONFIG,
	findCategory,
	findItemById,
	generateId,
	initCategoryDir,
	resolveCategories,
	updateItemStateInFile,
} from "@oh-my-pi/pi-org";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export interface OrgPlanDraft {
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
 * Finalize an approved plan:
 *   1. Mark the draft item as DONE.
 *   2. Create a new item in the active category with the plan content as body.
 *
 * Returns the new active item's id, or null on failure.
 */
export async function finalizePlanDraft(
	settings: Settings,
	projectRoot: string,
	draft: OrgPlanDraft,
	planTitle: string,
	planContent: string,
	/** When provided, prepended as an "* Initial message" section at the top of the plans item body. */
	initialMessage?: string,
): Promise<string | null> {
	if (!settings.get("org.enabled")) return null;

	const activeCategory = (settings.get("org.planActiveCategory") as string | undefined) ?? "plans";
	const activeState = (settings.get("org.planActiveState") as string | undefined) ?? "DOING";

	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, projectRoot);

	// 1. Mark draft DONE
	await updateItemStateInFile(draft.file, draft.id, "DONE", config.todoKeywords);

	// 2. Create active item
	const activeCat = findCategory(categories, activeCategory);
	if (!activeCat) {
		throw new Error(
			`org.planActiveCategory "${activeCategory}" not found. Known categories: ${categories.map(c => c.name).join(", ")}`,
		);
	}

	await initCategoryDir(activeCat.absPath, activeCat.prefix, config.todoKeywords);
	const activeId = await generateId(activeCat.absPath, activeCat.prefix, planTitle);
	const activeFilePath = path.join(activeCat.absPath, `${activeId}.org`);
	const body = initialMessage ? `* Initial message\n\n${initialMessage}\n\n${planContent}` : planContent;
	await appendItemToFile(
		activeFilePath,
		{ title: planTitle, category: activeCat.name, id: activeId, body },
		activeState,
	);

	logger.debug("org-plan: finalized plan", { draftId: draft.id, activeId, activeFilePath });
	return activeId;
}

/**
 * Resolve a plan draft item by its CUSTOM_ID across all configured categories.
 * Returns the item (with body) or null if not found / org disabled.
 */
export async function resolvePlanDraftItem(
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
