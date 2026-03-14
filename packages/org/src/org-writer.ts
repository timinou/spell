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
import type { ItemMutation, MemoryEntry, OrgCreateParams, OrgSessionContext } from "./types";

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

	if (session?.initialMessage) {
		lines.push("");
		lines.push("* Initial Message");
		lines.push("");
		lines.push(session.initialMessage.trimEnd());
	}

	if (body) {
		lines.push("");
		lines.push(body.trimEnd());
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
 * Apply multiple mutations to an item in a single read-write pass.
 *
 * Reads the file once, locates the item (file-level or heading-level),
 * applies state → title → body/append mutations in order, writes once.
 *
 * Returns the list of fields actually changed, or `null` if the item
 * was not found in this file.
 */
export async function applyItemMutations(
	filePath: string,
	customId: string,
	mutations: ItemMutation,
	todoKeywords: string[],
): Promise<string[] | null> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch {
		return null; // file does not exist — item not found
	}
	const lines = content.split("\n");

	const ctx = locateItem(lines, customId);
	if (!ctx) return null;

	const applied: string[] = [];

	// 1. State
	if (mutations.state) {
		const ok =
			ctx.kind === "file"
				? mutateFileLevelState(lines, ctx, mutations.state, mutations.note)
				: mutateHeadingState(lines, ctx, mutations.state, todoKeywords, mutations.note);
		if (ok) {
			applied.push("state");
			if (mutations.note) applied.push("note");
		}
	}

	// 2. Title
	if (mutations.title) {
		const ok =
			ctx.kind === "file"
				? mutateFileLevelTitle(lines, ctx, mutations.title)
				: mutateHeadingTitle(lines, ctx, mutations.title, todoKeywords);
		if (ok) applied.push("title");
	}

	// 3. Body replace and/or append
	//    Body replace runs first. If both body and append are set,
	//    append applies on top of the replaced body (fresh range lookup).
	if (mutations.body !== undefined) {
		const ok =
			ctx.kind === "file"
				? spliceFileLevelBody(lines, ctx, mutations.body)
				: spliceHeadingBody(lines, ctx, mutations.body);
		if (ok) applied.push("body");
	}

	if (mutations.append !== undefined) {
		// Re-locate the body range — earlier mutations (state note, body replace)
		// may have shifted line indices via splice.
		const freshCtx = locateItem(lines, customId);
		if (freshCtx) {
			const range =
				freshCtx.kind === "file"
					? { start: freshCtx.bodyStart, end: lines.length }
					: { start: freshCtx.bodyStart, end: freshCtx.bodyEnd };
			const existing = lines.slice(range.start, range.end).join("\n").trimEnd();
			const combined = existing ? `${existing}\n\n${mutations.append.trimEnd()}` : mutations.append.trimEnd();
			const ok =
				freshCtx.kind === "file"
					? spliceFileLevelBody(lines, freshCtx, combined)
					: spliceHeadingBody(lines, freshCtx, combined);
			if (ok) applied.push("append");
		}
	}

	if (applied.length === 0) return applied;

	await Bun.write(filePath, lines.join("\n"));
	return applied;
}

// =============================================================================
// Item location — single-pass parsers
// =============================================================================

/** Parsed frontmatter context for a file-level item. */
interface FileLevelContext {
	kind: "file";
	stateLineIdx: number; // -1 if no #+STATE: line
	titleLineIdx: number; // -1 if no #+TITLE: line
	lastFrontmatterIdx: number;
	bodyStart: number; // first line after frontmatter
}

/** Parsed context for a heading-level item. */
interface HeadingContext {
	kind: "heading";
	headingLineIdx: number;
	drawerEnd: number; // line index of :END:
	bodyStart: number; // first line after :END:
	bodyEnd: number; // exclusive — next heading or EOF
}

type ItemContext = FileLevelContext | HeadingContext;

/**
 * Locate an item by CUSTOM_ID in a parsed line array.
 *
 * Tries file-level first (frontmatter `#+CUSTOM_ID:`), then heading-level
 * (`:CUSTOM_ID:` in a PROPERTIES drawer). Returns a context struct with
 * pre-computed line indices for all mutation operations, or `null` if not found.
 */
function locateItem(lines: string[], customId: string): ItemContext | null {
	// 1. Try file-level: scan #+KEY: frontmatter block
	let foundInFrontmatter = false;
	let stateLineIdx = -1;
	let titleLineIdx = -1;
	let lastFrontmatterIdx = -1;
	let i = 0;
	while (i < lines.length && lines[i].startsWith("#+")) {
		const line = lines[i];
		if (line.startsWith("#+CUSTOM_ID:") && line.slice("#+CUSTOM_ID:".length).trim() === customId) {
			foundInFrontmatter = true;
		}
		if (line.startsWith("#+STATE:")) stateLineIdx = i;
		if (line.startsWith("#+TITLE:")) titleLineIdx = i;
		lastFrontmatterIdx = i;
		i++;
	}
	if (foundInFrontmatter) {
		return { kind: "file", stateLineIdx, titleLineIdx, lastFrontmatterIdx, bodyStart: i };
	}

	// 2. Try heading-level: find :CUSTOM_ID: in a PROPERTIES drawer
	const needle = `:CUSTOM_ID: ${customId}`;
	for (let idx = 0; idx < lines.length; idx++) {
		if (lines[idx].trim() !== needle) continue;

		// Walk backwards to find the heading line
		let headingLineIdx = -1;
		for (let j = idx - 1; j >= 0; j--) {
			if (lines[j].startsWith("*")) {
				headingLineIdx = j;
				break;
			}
		}
		if (headingLineIdx === -1) continue;

		// Walk forward to find :END:
		let drawerEnd = -1;
		for (let j = idx + 1; j < lines.length; j++) {
			if (lines[j].trim() === ":END:") {
				drawerEnd = j;
				break;
			}
		}
		if (drawerEnd === -1) continue; // malformed drawer, skip

		// Body runs from after :END: to the next heading or EOF
		const bodyStart = drawerEnd + 1;
		let bodyEnd = lines.length;
		for (let k = bodyStart; k < lines.length; k++) {
			if (lines[k].startsWith("*")) {
				bodyEnd = k;
				break;
			}
		}

		return { kind: "heading", headingLineIdx, drawerEnd, bodyStart, bodyEnd };
	}

	return null;
}

// =============================================================================
// Mutation helpers — operate on pre-located contexts, mutate lines in place
// =============================================================================

function mutateFileLevelState(lines: string[], ctx: FileLevelContext, newState: string, note?: string): boolean {
	if (ctx.stateLineIdx === -1) return false;
	lines[ctx.stateLineIdx] = `#+STATE: ${newState}`;
	if (note) {
		const insertIdx = ctx.lastFrontmatterIdx + 1;
		lines.splice(insertIdx, 0, "", `NOTE [${new Date().toISOString().slice(0, 10)}]: ${note}`);
	}
	return true;
}

function mutateHeadingState(
	lines: string[],
	ctx: HeadingContext,
	newState: string,
	todoKeywords: string[],
	note?: string,
): boolean {
	const headingLine = lines[ctx.headingLineIdx];
	const keywordsPattern = todoKeywords.join("|");
	const replaced = headingLine.replace(new RegExp(`^(\\*+)\\s+(${keywordsPattern})\\s+`), `$1 ${newState} `);
	if (replaced === headingLine) return false;
	lines[ctx.headingLineIdx] = replaced;
	if (note) {
		lines.splice(ctx.drawerEnd + 1, 0, "", `  NOTE [${new Date().toISOString().slice(0, 10)}]: ${note}`);
	}
	return true;
}

function mutateFileLevelTitle(lines: string[], ctx: FileLevelContext, newTitle: string): boolean {
	if (ctx.titleLineIdx === -1) return false;
	lines[ctx.titleLineIdx] = `#+TITLE: ${newTitle}`;
	return true;
}

function mutateHeadingTitle(lines: string[], ctx: HeadingContext, newTitle: string, todoKeywords: string[]): boolean {
	const line = lines[ctx.headingLineIdx];
	const match = /^(\*+)\s+(.+)$/.exec(line);
	if (!match) return false;
	const stars = match[1];
	const rest = match[2].trim();
	const spaceIdx = rest.indexOf(" ");
	const keyword = spaceIdx !== -1 ? rest.slice(0, spaceIdx) : "";
	if (todoKeywords.includes(keyword)) {
		lines[ctx.headingLineIdx] = `${stars} ${keyword} ${newTitle}`;
	} else {
		lines[ctx.headingLineIdx] = `${stars} ${newTitle}`;
	}
	return true;
}

function spliceFileLevelBody(lines: string[], ctx: FileLevelContext, newBody: string | null): boolean {
	// Skip leading blank lines between frontmatter and body content
	let bodyStart = ctx.bodyStart;
	const bodyEnd = lines.length;
	while (bodyStart < bodyEnd && lines[bodyStart].trim() === "") bodyStart++;

	const replacement = newBody ? newBody.trimEnd().split("\n") : [];
	replacement.push(""); // trailing blank line for clean formatting
	lines.splice(bodyStart, bodyEnd - bodyStart, ...replacement);
	return true;
}

function spliceHeadingBody(lines: string[], ctx: HeadingContext, newBody: string | null): boolean {
	const replacement: string[] = newBody ? ["", ...newBody.trimEnd().split("\n"), ""] : [""];
	lines.splice(ctx.bodyStart, ctx.bodyEnd - ctx.bodyStart, ...replacement);
	return true;
}

// =============================================================================
// Public thin wrappers — single-mutation convenience functions
// =============================================================================

/**
 * Update the state of an item identified by CUSTOM_ID in a file.
 * Returns true if the item was found and updated, false otherwise.
 */
export async function updateItemStateInFile(
	filePath: string,
	customId: string,
	newState: string,
	todoKeywords: string[],
	note?: string,
): Promise<boolean> {
	const result = await applyItemMutations(filePath, customId, { state: newState, note }, todoKeywords);
	return result !== null && result.length > 0;
}

/**
 * Replace the body text of an item identified by CUSTOM_ID.
 * Pass `null` to clear the body. Returns true if found and updated.
 */
export async function updateItemBodyInFile(
	filePath: string,
	customId: string,
	newBody: string | null,
	todoKeywords: string[],
): Promise<boolean> {
	const result = await applyItemMutations(filePath, customId, { body: newBody }, todoKeywords);
	return result !== null && result.length > 0;
}

/**
 * Append text to the end of an item's body.
 * Returns true if the item was found, false otherwise.
 */
export async function appendToItemBodyInFile(
	filePath: string,
	customId: string,
	text: string,
	todoKeywords: string[],
): Promise<boolean> {
	const result = await applyItemMutations(filePath, customId, { append: text }, todoKeywords);
	return result !== null && result.length > 0;
}

/**
 * Update the title of an item identified by CUSTOM_ID.
 * Returns true if found and updated, false otherwise.
 */
export async function updateItemTitleInFile(
	filePath: string,
	customId: string,
	newTitle: string,
	todoKeywords: string[],
): Promise<boolean> {
	const result = await applyItemMutations(filePath, customId, { title: newTitle }, todoKeywords);
	return result !== null && result.length > 0;
}

// =============================================================================
// Property mutation (separate from applyItemMutations — different domain)
// =============================================================================

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
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch {
		return false;
	}
	const lines = content.split("\n");
	const ctx = locateItem(lines, customId);
	if (!ctx) return false;

	const ok =
		ctx.kind === "file"
			? setFileLevelProperty(lines, ctx, property, value)
			: setHeadingProperty(lines, ctx, customId, property, value);
	if (!ok) return false;

	await Bun.write(filePath, lines.join("\n"));
	return true;
}

function setFileLevelProperty(lines: string[], ctx: FileLevelContext, property: string, value: string): boolean {
	const prefix = `#+${property}:`;
	let existingPropIdx = -1;
	for (let i = 0; i <= ctx.lastFrontmatterIdx; i++) {
		if (lines[i].startsWith(prefix)) {
			existingPropIdx = i;
		}
	}

	const propLine = `#+${property}: ${value}`;
	if (existingPropIdx !== -1) {
		lines[existingPropIdx] = propLine;
	} else {
		lines.splice(ctx.lastFrontmatterIdx + 1, 0, propLine);
	}
	return true;
}

function setHeadingProperty(
	lines: string[],
	_ctx: HeadingContext,
	customId: string,
	property: string,
	value: string,
): boolean {
	// Re-locate the drawer boundaries for property insertion
	const needle = `:CUSTOM_ID: ${customId}`;
	let drawerStart = -1;
	let drawerEnd = -1;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== needle) continue;
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

// =============================================================================
// Memory entry serialization
// =============================================================================

/**
 * Serialize a single MemoryEntry to an org heading block.
 *
 * The CUSTOM_ID is derived from the title slug with a "MEM-" prefix.
 * Tags are built from scope path segments plus any explicit extra tags.
 */
export function serializeMemoryEntry(entry: MemoryEntry): string {
	// Tags: deduplicated scope segments + caller-supplied extras
	const scopeParts = entry.scope.split("/").filter(Boolean);
	const allTags = [...new Set([...scopeParts, ...(entry.tags ?? [])])];
	const tagStr = allTags.length > 0 ? `  :${allTags.join(":")}:` : "";

	// CUSTOM_ID: "MEM-" + kebab slug from title (max 40 chars)
	const slug = entry.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const id = `MEM-${slug}`;

	// Org inactive timestamp for today
	const now = new Date();
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const dateStr = `[${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${days[now.getDay()]}]`;

	const lines: string[] = [
		`* ${entry.title}${tagStr}`,
		":PROPERTIES:",
		`:CUSTOM_ID: ${id}`,
		`:CONFIDENCE: ${entry.confidence.toFixed(2)}`,
		`:LAST_VALIDATED: ${dateStr}`,
		`:SCOPE: ${entry.scope}`,
		`:SOURCE_SESSION: ${entry.sourceSession}`,
		":END:",
		"",
		entry.body.trimEnd(),
		"",
	];
	return lines.join("\n");
}

/**
 * Wrap multiple MemoryEntry values into a complete org file with file-level
 * header metadata.
 */
export function serializeMemoryFile(entries: MemoryEntry[], sourceSession: string): string {
	const now = new Date();
	const dateStr = now.toISOString().split("T")[0];
	const header = [
		`#+TITLE: Spell Long-Term Memory`,
		`#+LAST_UPDATED: ${dateStr}`,
		`#+SOURCE_SESSION: ${sourceSession}`,
		"",
	].join("\n");
	return header + entries.map(serializeMemoryEntry).join("");
}
