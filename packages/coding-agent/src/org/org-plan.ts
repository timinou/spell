/**
 * Org integration: PLAN config + item resolution helpers.
 *
 * Operations throw on failure; callers are responsible for surfacing errors.
 */
import { DEFAULT_ORG_CONFIG, findItemById, resolveCategories } from "@spell/pi-org";
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
