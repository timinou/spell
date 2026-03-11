/**
 * Category resolution: takes project root + org config and resolves logical
 * category names to absolute filesystem paths.
 */

import * as path from "node:path";
import type { OrgCategory, OrgConfig } from "./types";

/**
 * Resolve all categories from config relative to the given project root.
 *
 * Returns a flat list of OrgCategory objects with absolute paths resolved.
 * Categories across multiple org dirs are merged into a single list.
 */
export function resolveCategories(config: OrgConfig, projectRoot: string): OrgCategory[] {
	const result: OrgCategory[] = [];

	for (const [dirName, dirConfig] of Object.entries(config.dirs)) {
		const dirAbsPath = path.resolve(projectRoot, dirConfig.path);

		for (const [catName, catConfig] of Object.entries(dirConfig.categories)) {
			result.push({
				dirName,
				name: catName,
				prefix: catConfig.prefix,
				absPath: path.resolve(dirAbsPath, catConfig.path),
				dirAbsPath,
				agent: catConfig.agent ?? dirConfig.agent,
				writeInitialPrompt: catConfig.writeInitialPrompt ?? true,
			});
		}
	}

	return result;
}

/**
 * Find a category by logical name (e.g. "projects") or prefix (e.g. "PROJ").
 * Returns undefined if not found.
 */
export function findCategory(categories: OrgCategory[], nameOrPrefix: string): OrgCategory | undefined {
	const upper = nameOrPrefix.toUpperCase();
	return categories.find(c => c.name === nameOrPrefix || c.prefix === upper);
}

/**
 * Find a category that owns a given CUSTOM_ID.
 * The prefix is the part before the first hyphen in the ID.
 */
export function findCategoryForId(categories: OrgCategory[], customId: string): OrgCategory | undefined {
	const prefix = customId.split("-")[0];
	return categories.find(c => c.prefix === prefix);
}
