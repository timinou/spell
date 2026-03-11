/**
 * Raw org file writer — no Emacs required.
 *
 * Two item representations:
 *
 *   1. **File-level items** — metadata lives in `#+KEY: value` lines at the top
 *      of the file. The body is free-form content (headings, prose, etc.) below
 *      the frontmatter block. Used when creating a new file for a single item.
 *
 *   2. **Heading-level items** — `* STATE title` with a `:PROPERTIES:` drawer.
 *      Used for sub-tasks within a file or when appending to an existing file.
 *
 * All file mutations go through atomic write (write to temp, rename). This
 * avoids partial writes if the process is killed mid-write.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_TODO_KEYWORDS } from "./schema/defaults";
import type { OrgCreateParams, OrgSessionContext } from "./types";

// =============================================================================
// Serialization helpers
// =============================================================================

/**
 * Serialize file-level `#+KEY: value` frontmatter for a document item.
 *
 * The resulting file has metadata at the top and free-form body content below.
 * When `session` is provided, `#+SESSION_ID:` and `#+TRANSCRIPT_PATH:` are
 * written into the frontmatter and an `* Initial Prompt` section is appended.
 */
export function serializeFileItem(
	title: string,
	state: string,
	props: Record<string, string>,
	body?: string,
	session?: OrgSessionContext,
): string {
	const fileTitle = title.replace(/[^\w\s-]/g, "").trim();
	const lines: string[] = [];

	lines.push(`#+TITLE: ${fileTitle}`);
	lines.push(`#+STATE: ${state}`);
	if (session?.sessionId) {
		lines.push(`#+SESSION_ID: ${session.sessionId}`);
	}
	if (session?.transcriptPath) {
		lines.push(`#+TRANSCRIPT_PATH: [[file:${session.transcriptPath}]]`);
	}
	for (const [key, value] of Object.entries(props)) {
		lines.push(`#+${key}: ${value}`);
	}

	if (body) {
		lines.push("");
		lines.push(body.trimEnd());
	}

	if (session?.systemPrompt) {
		lines.push("");
		lines.push("* Initial Prompt");
		lines.push("");
		lines.push(session.systemPrompt.trimEnd());
	}

	lines.push("");
	return lines.join("\n");
}

/**
 * Serialize an org heading with a PROPERTIES drawer.
 *
 * @param level - Heading level (1 = *, 2 = **, etc.)
 * @param state - TODO keyword (e.g. "ITEM")
 * @param title - Heading title text
 * @param props - Properties to write in the drawer
 * @param body - Optional body text below the drawer
 */
export function serializeHeading(
	level: number,
	state: string,
	title: string,
	props: Record<string, string>,
	body?: string,
): string {
	const stars = "*".repeat(Math.max(1, level));
	const lines: string[] = [`${stars} ${state} ${title}`];

	// Properties drawer
	lines.push(":PROPERTIES:");
	for (const [key, value] of Object.entries(props)) {
		lines.push(`:${key}: ${value}`);
	}
	lines.push(":END:");

	if (body) {
		lines.push("");
		lines.push(body.trimEnd());
	}

	lines.push("");
	return lines.join("\n");
}

// =============================================================================
// File-level operations
// =============================================================================

/**
 * Create or append an item to an org file.
 *
 * - **New file**: writes file-level `#+` properties (document item).
 *   If `session` is provided, session metadata and the initial prompt are
 *   embedded (see `serializeFileItem`).
 * - **Existing file**: appends a heading-level item. Session context is not
 *   written — it belongs to the file, not individual headings.
 *
 * Returns the absolute path of the written file.
 */
export async function appendItemToFile(
	filePath: string,
	params: OrgCreateParams & { id: string },
	state: string,
	session?: OrgSessionContext,
): Promise<string> {
	const props: Record<string, string> = {
		CUSTOM_ID: params.id,
		...params.properties,
	};

	let existing: string;
	try {
		existing = await Bun.file(filePath).text();
	} catch {
		// New file — use file-level properties with optional session context
		const content = serializeFileItem(params.title, state, props, params.body, session);
		await Bun.write(filePath, content);
		return filePath;
	}

	// Existing file — append as heading-level item; session context stays with the file
	const heading = serializeHeading(1, state, params.title, props, params.body);
	const separator = existing.endsWith("\n") ? "" : "\n";
	await Bun.write(filePath, existing + separator + heading);
	return filePath;
}

/**
 * Update the state of an item identified by CUSTOM_ID in a file.
 *
 * Handles both file-level items (`#+STATE:` / `#+CUSTOM_ID:`) and
 * heading-level items (`* STATE title` with `:PROPERTIES:` drawer).
 *
 * Returns true if the item was found and updated, false otherwise.
 */
export async function updateItemStateInFile(
	filePath: string,
	customId: string,
	newState: string,
	todoKeywords: string[],
	note?: string,
): Promise<boolean> {
	const content = await Bun.file(filePath).text();
	const lines = content.split("\n");

	// Try file-level item first: #+CUSTOM_ID: matches AND #+STATE: exists
	if (tryUpdateFileLevelState(lines, customId, newState, note)) {
		await Bun.write(filePath, lines.join("\n"));
		return true;
	}

	// Fall back to heading-level item
	if (tryUpdateHeadingLevelState(lines, customId, newState, todoKeywords, note)) {
		await Bun.write(filePath, lines.join("\n"));
		return true;
	}

	return false;
}

function tryUpdateFileLevelState(lines: string[], customId: string, newState: string, note?: string): boolean {
	let hasCustomId = false;
	let stateLineIdx = -1;
	let lastFrontmatterIdx = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("#+")) break;

		if (line.startsWith("#+CUSTOM_ID:") && line.slice("#+CUSTOM_ID:".length).trim() === customId) {
			hasCustomId = true;
		}
		if (line.startsWith("#+STATE:")) {
			stateLineIdx = i;
		}
		lastFrontmatterIdx = i;
	}

	if (!hasCustomId || stateLineIdx === -1) return false;

	lines[stateLineIdx] = `#+STATE: ${newState}`;

	if (note) {
		const insertIdx = lastFrontmatterIdx + 1;
		lines.splice(insertIdx, 0, "", `NOTE [${new Date().toISOString().slice(0, 10)}]: ${note}`);
	}

	return true;
}

function tryUpdateHeadingLevelState(
	lines: string[],
	customId: string,
	newState: string,
	todoKeywords: string[],
	note?: string,
): boolean {
	// Find the PROPERTIES drawer that contains our CUSTOM_ID
	let headingLineIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === `:CUSTOM_ID: ${customId}`) {
			// Walk backwards to find the heading line
			for (let j = i - 1; j >= 0; j--) {
				if (lines[j].startsWith("*")) {
					headingLineIdx = j;
					break;
				}
			}
			break;
		}
	}

	if (headingLineIdx === -1) return false;

	const headingLine = lines[headingLineIdx];
	const keywordsPattern = todoKeywords.join("|");
	const replaced = headingLine.replace(new RegExp(`^(\\*+)\\s+(${keywordsPattern})\\s+`), `$1 ${newState} `);

	if (replaced === headingLine) return false;

	lines[headingLineIdx] = replaced;

	if (note) {
		let endIdx = headingLineIdx + 1;
		while (endIdx < lines.length && lines[endIdx].trim() !== ":END:") {
			endIdx++;
		}
		lines.splice(endIdx + 1, 0, ``, `  NOTE [${new Date().toISOString().slice(0, 10)}]: ${note}`);
	}

	return true;
}

/**
 * Set or update a property on an item identified by CUSTOM_ID.
 *
 * Handles both file-level items (`#+KEY: value`) and heading-level items
 * (`:KEY: value` inside `:PROPERTIES:` drawer).
 *
 * Returns true on success, false if item not found.
 */
export async function setPropertyInFile(
	filePath: string,
	customId: string,
	property: string,
	value: string,
): Promise<boolean> {
	const content = await Bun.file(filePath).text();
	const lines = content.split("\n");

	// Try file-level item first
	if (trySetFileLevelProperty(lines, customId, property, value)) {
		await Bun.write(filePath, lines.join("\n"));
		return true;
	}

	// Fall back to heading-level item
	if (trySetHeadingLevelProperty(lines, customId, property, value)) {
		await Bun.write(filePath, lines.join("\n"));
		return true;
	}

	return false;
}

function trySetFileLevelProperty(lines: string[], customId: string, property: string, value: string): boolean {
	let hasCustomId = false;
	let lastFrontmatterIdx = -1;
	let existingPropIdx = -1;
	const prefix = `#+${property}:`;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("#+")) break;

		if (line.startsWith("#+CUSTOM_ID:") && line.slice("#+CUSTOM_ID:".length).trim() === customId) {
			hasCustomId = true;
		}
		if (line.startsWith(prefix)) {
			existingPropIdx = i;
		}
		lastFrontmatterIdx = i;
	}

	if (!hasCustomId) return false;

	const propLine = `#+${property}: ${value}`;
	if (existingPropIdx !== -1) {
		lines[existingPropIdx] = propLine;
	} else {
		// Insert after the last frontmatter line
		lines.splice(lastFrontmatterIdx + 1, 0, propLine);
	}

	return true;
}

function trySetHeadingLevelProperty(lines: string[], customId: string, property: string, value: string): boolean {
	let drawerStart = -1;
	let drawerEnd = -1;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === `:CUSTOM_ID: ${customId}`) {
			for (let j = i - 1; j >= 0; j--) {
				if (lines[j].trim() === ":PROPERTIES:") {
					drawerStart = j;
					break;
				}
				if (lines[j].startsWith("*")) break;
			}
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim() === ":END:") {
					drawerEnd = j;
					break;
				}
			}
			break;
		}
	}

	if (drawerStart === -1 || drawerEnd === -1) return false;

	const propLine = `:${property}: ${value}`;
	const existingIdx = lines.slice(drawerStart, drawerEnd).findIndex(l => l.trimStart().startsWith(`:${property}:`));

	if (existingIdx !== -1) {
		lines[drawerStart + existingIdx] = propLine;
	} else {
		lines.splice(drawerEnd, 0, propLine);
	}

	return true;
}

// =============================================================================
// Category directory initializer
// =============================================================================

/**
 * Ensure a category directory exists with a reference.org file.
 * No-op if directory already exists.
 */
export async function initCategoryDir(
	categoryAbsPath: string,
	prefix: string,
	todoKeywords: string[] = [...DEFAULT_TODO_KEYWORDS],
): Promise<void> {
	await fs.mkdir(categoryAbsPath, { recursive: true });

	const refPath = path.join(path.dirname(categoryAbsPath), "reference.org");

	// Only create if it doesn't exist yet — don't overwrite user edits
	try {
		await Bun.file(refPath).text();
	} catch {
		const referenceContent = buildReferenceOrg(prefix, todoKeywords);
		await Bun.write(refPath, referenceContent);
	}
}

function buildReferenceOrg(prefix: string, todoKeywords: string[]): string {
	const keywords = todoKeywords.join(" | ");
	return `#+TITLE: Reference
#+DESCRIPTION: Schema contract for this org directory.
#+TODO: ${keywords}

* Schema

** Task ID Format

Task IDs follow the pattern: ${prefix}-NNN-kebab-title
Example: ${prefix}-001-implement-feature

** TODO Keywords

| Keyword | Meaning                            |
|---------+------------------------------------|
| ITEM    | Not started                        |
| DOING   | Actively being worked on           |
| REVIEW  | Work done, awaiting review         |
| DONE    | Complete                           |
| BLOCKED | Waiting on external dependency     |

** File Structure

Each item is one file. File-level properties define the item:

#+TITLE: Example Task
#+STATE: ITEM
#+CUSTOM_ID: ${prefix}-001-example-task
#+EFFORT: 2h
#+PRIORITY: #B
#+LAYER: backend

Description of what needs to be done and why.

* Sub-section (free-form heading)
Prose, diagrams, notes — whatever the item needs.

** ITEM ${prefix}-002-sub-task
:PROPERTIES:
:CUSTOM_ID: ${prefix}-002-sub-task
:EFFORT: 1h
:END:

Headings with TODO keywords are actionable sub-tasks.

** Recommended Properties

- DEPENDS: IDs this task depends on (space-separated)
- BLOCKS: IDs this task blocks
- FILES: Relevant files (paths)
- TEST_PLAN: How to verify completion
- LAYER: backend | frontend | data | prompt | infra | test | docs

** Optional Properties

- BLAST_RADIUS: Scope of impact
- FEATURE_FLAG: Associated feature flag
- RESEARCH_REF: Link to research or spike
- AGENT: Override default agent for this item
`;
}
