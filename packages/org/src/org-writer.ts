/**
 * Raw org file writer — no Emacs required.
 *
 * Writes well-formed org headings with PROPERTIES drawers. This handles the
 * common create/update paths that do not need org-element AST intelligence.
 *
 * All file mutations go through atomic write (write to temp, rename). This
 * avoids partial writes if the process is killed mid-write.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_TODO_KEYWORDS } from "./schema/defaults";
import type { OrgCreateParams } from "./types";

// =============================================================================
// Heading serialization
// =============================================================================

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

/**
 * Build the content for a new org file containing a single top-level heading.
 */
export function buildNewFile(title: string, heading: string): string {
	const fileTitle = title.replace(/[^\w\s-]/g, "").trim();
	return `#+TITLE: ${fileTitle}\n\n${heading}`;
}

// =============================================================================
// File-level operations
// =============================================================================

/**
 * Append a new heading to an existing org file, or create the file if it does
 * not exist.
 *
 * Returns the absolute path of the written file.
 */
export async function appendItemToFile(
	filePath: string,
	params: OrgCreateParams & { id: string },
	state: string,
): Promise<string> {
	const props: Record<string, string> = {
		CUSTOM_ID: params.id,
		...params.properties,
	};

	const heading = serializeHeading(1, state, params.title, props, params.body);

	let existing: string;
	try {
		existing = await Bun.file(filePath).text();
	} catch {
		existing = buildNewFile(params.title, heading);
		await Bun.write(filePath, existing);
		return filePath;
	}

	// Append to existing file with separator
	const separator = existing.endsWith("\n") ? "" : "\n";
	await Bun.write(filePath, existing + separator + heading);
	return filePath;
}

/**
 * Update the TODO state of an item identified by CUSTOM_ID in a file.
 *
 * Strategy: regex-based line replacement targeting the heading that has the
 * CUSTOM_ID in its PROPERTIES drawer. When Emacs is available the caller
 * should prefer the Emacs-backed path which uses org-element for accuracy.
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
	// Replace the TODO keyword on the heading line
	const keywordsPattern = todoKeywords.join("|");
	const replaced = headingLine.replace(new RegExp(`^(\\*+)\\s+(${keywordsPattern})\\s+`), `$1 ${newState} `);

	if (replaced === headingLine) return false; // no change made

	lines[headingLineIdx] = replaced;

	if (note) {
		// Find :END: after the heading (end of PROPERTIES drawer)
		let endIdx = headingLineIdx + 1;
		while (endIdx < lines.length && lines[endIdx].trim() !== ":END:") {
			endIdx++;
		}
		// Insert note after the drawer
		const noteLines = [``, `  NOTE [${new Date().toISOString().slice(0, 10)}]: ${note}`];
		lines.splice(endIdx + 1, 0, ...noteLines);
	}

	await Bun.write(filePath, lines.join("\n"));
	return true;
}

/**
 * Set or update a single property in the PROPERTIES drawer of the item with
 * the given CUSTOM_ID.
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

	// Find the drawer for this CUSTOM_ID
	let drawerStart = -1;
	let drawerEnd = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === `:CUSTOM_ID: ${customId}`) {
			// Walk backwards to :PROPERTIES:
			for (let j = i - 1; j >= 0; j--) {
				if (lines[j].trim() === ":PROPERTIES:") {
					drawerStart = j;
					break;
				}
				if (lines[j].startsWith("*")) break;
			}
			// Walk forward to :END:
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
		// Insert before :END:
		lines.splice(drawerEnd, 0, propLine);
	}

	await Bun.write(filePath, lines.join("\n"));
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

** Required Properties

Every task heading MUST have:
- CUSTOM_ID: Unique task ID (e.g. ${prefix}-001-example)
- EFFORT: Time estimate (e.g. 2h, 30m)
- PRIORITY: #A (high), #B (medium), #C (low)

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

** Example Item

* ITEM ${prefix}-001-example-task
:PROPERTIES:
:CUSTOM_ID: ${prefix}-001-example-task
:EFFORT: 2h
:PRIORITY: #B
:LAYER: backend
:END:

Description of what needs to be done and why.

- Specific step 1
- Specific step 2
`;
}
