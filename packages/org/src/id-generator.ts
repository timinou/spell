/**
 * Task ID generation: {PREFIX}-{zero-padded-num}-kebab-title
 *
 * Scans existing org files in a category directory to find the current maximum
 * sequence number, then increments by one for the new item.
 *
 * IDs are scoped per category prefix — PROJ-042 and BUG-042 are distinct.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const ID_PADDING = 3; // zero-pad to e.g. 042

/**
 * Convert a heading title to a URL-safe kebab slug.
 * Strips special characters, collapses whitespace, lowercases.
 */
export function titleToSlug(title: string): string {
	return (
		title
			.toLowerCase()
			// treat underscores, dots, and slashes as word separators
			.replace(/[_.\\/]+/g, " ")
			// keep alphanumeric and spaces/hyphens
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/[\s-]+/g, "-")
			// cap length so IDs don't become unwieldy
			.slice(0, 40)
			.replace(/-+$/, "")
	);
}

/**
 * Scan all .org files in the category directory and return the maximum
 * sequence number already used for the given prefix.
 *
 * The scan reads file contents to find CUSTOM_ID properties rather than
 * relying solely on filenames, because items with different IDs may coexist
 * in the same file.
 */
export async function scanMaxSequence(categoryAbsPath: string, prefix: string): Promise<number> {
	let max = 0;

	let entries: string[];
	try {
		entries = await fs.readdir(categoryAbsPath);
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}

	const orgFiles = entries.filter(e => e.endsWith(".org"));
	// Regex matches :CUSTOM_ID: PREFIX-NNN or PREFIX-NNN-slug anywhere in the file
	const idRe = new RegExp(`:CUSTOM_ID:\\s+${prefix}-(\\d+)`, "g");

	await Promise.all(
		orgFiles.map(async file => {
			const fullPath = path.join(categoryAbsPath, file);
			try {
				const content = await Bun.file(fullPath).text();
				for (const match of content.matchAll(idRe)) {
					const n = Number.parseInt(match[1], 10);
					if (Number.isFinite(n) && n > max) max = n;
				}
			} catch {
				// Skip unreadable files — don't block generation
			}
		}),
	);

	return max;
}

/**
 * Generate the next task ID for a category.
 *
 * Format: `{PREFIX}-{NNN}-{slug}`
 * Example: `PROJ-042-auth-refactor`
 */
export async function generateId(categoryAbsPath: string, prefix: string, title: string): Promise<string> {
	const max = await scanMaxSequence(categoryAbsPath, prefix);
	const next = max + 1;
	const num = String(next).padStart(ID_PADDING, "0");
	const slug = titleToSlug(title);
	return slug ? `${prefix}-${num}-${slug}` : `${prefix}-${num}`;
}

/**
 * Parse a task ID into its components.
 * Returns null if the format is not recognized.
 */
export function parseId(id: string): { prefix: string; num: number; slug: string } | null {
	const match = /^([A-Z]+)-(\d+)(?:-(.+))?$/.exec(id);
	if (!match) return null;
	return {
		prefix: match[1],
		num: Number.parseInt(match[2], 10),
		slug: match[3] ?? "",
	};
}
