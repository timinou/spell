/**
 * Basic TypeScript-based org file reader — no Emacs required.
 *
 * Provides heading + properties extraction sufficient for:
 *   - org query (list items by state / category / priority)
 *   - org get (single item with body)
 *   - Dashboard counts (state totals)
 *
 * For full org-element AST fidelity (wave, validate, dependency graphs),
 * the Emacs-backed client supersedes this.
 *
 * Two item representations are supported:
 *
 *   1. **File-level items** — metadata in `#+KEY: value` frontmatter lines.
 *      Body is everything after the frontmatter block. Recognized when the
 *      file has a `#+CUSTOM_ID:` line. Produces a level-0 item.
 *
 *   2. **Heading-level items** — `* STATE title` with `:PROPERTIES:` drawer.
 *      Body is text between `:END:` and the next heading at same or higher
 *      level.
 *
 * Parsing approach: line-by-line state machine, no regex backtracking.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { OrgItem, OrgQueryFilter } from "./types";

// =============================================================================
// Frontmatter parser
// =============================================================================

interface FileLevelItem {
	properties: Record<string, string>;
	state: string | null;
	title: string;
	/** 0-indexed line where body content starts (after frontmatter + blank lines). */
	bodyStartIdx: number;
}

/**
 * Parse `#+KEY: value` lines at the top of the file.
 *
 * Returns null if no `#+CUSTOM_ID:` is found (not a file-level item).
 */
function parseFileFrontmatter(lines: string[], todoKeywords: Set<string>): FileLevelItem | null {
	const properties: Record<string, string> = {};
	let state: string | null = null;
	let title = "";
	let i = 0;

	// Consume all leading #+KEY: lines
	while (i < lines.length && lines[i].startsWith("#+")) {
		const match = /^#\+([A-Za-z_]+):\s*(.*)$/.exec(lines[i]);
		if (match) {
			const key = match[1].toUpperCase();
			const value = match[2].trim();

			if (key === "TITLE") {
				title = value;
			} else if (key === "STATE") {
				state = todoKeywords.has(value) ? value : null;
			} else {
				properties[key] = value;
			}
		}
		i++;
	}

	if (!properties.CUSTOM_ID) return null;

	// Skip blank lines between frontmatter and body
	while (i < lines.length && lines[i].trim() === "") i++;

	return { properties, state, title, bodyStartIdx: i };
}

// =============================================================================
// Heading-level parser
// =============================================================================

interface HeadingLine {
	level: number;
	state: string | null;
	title: string;
	rawLine: string;
	lineNum: number; // 1-indexed
}

function parseHeadingLine(line: string, lineNum: number, todoKeywords: Set<string>): HeadingLine | null {
	// Fast check: must start with *
	if (!line.startsWith("*")) return null;

	const match = /^(\*+)\s+(.+)$/.exec(line);
	if (!match) return null;

	const level = match[1].length;
	const rest = match[2].trim();

	// Check for TODO keyword at start
	const spaceIdx = rest.indexOf(" ");
	if (spaceIdx !== -1) {
		const firstWord = rest.slice(0, spaceIdx);
		if (todoKeywords.has(firstWord)) {
			return {
				level,
				state: firstWord,
				title: rest.slice(spaceIdx + 1).trim(),
				rawLine: line,
				lineNum,
			};
		}
	}

	// No TODO keyword — structural heading, not a task item
	return {
		level,
		state: null,
		title: rest.trim(),
		rawLine: line,
		lineNum,
	};
}

// =============================================================================
// File-level parser
// =============================================================================

interface ParsedItem {
	level: number;
	state: string | null;
	title: string;
	lineNum: number;
	properties: Record<string, string>;
	bodyLines: string[];
	childIndices: number[]; // indices into items array
}

/**
 * Parse all items from a single org file.
 *
 * Returns a flat list; caller can reconstruct hierarchy via childIndices.
 * Includes both file-level items (level 0) and heading-level items.
 */
function parseOrgFile(content: string, todoKeywords: Set<string>): ParsedItem[] {
	const lines = content.split("\n");
	const items: ParsedItem[] = [];

	// Try to parse file-level item from frontmatter
	const fileLevelItem = parseFileFrontmatter(lines, todoKeywords);

	let headingScanStart = 0;

	if (fileLevelItem) {
		// File-level item at level 0 — body is everything from bodyStartIdx
		// to the first heading-level TODO item (or end of file).
		const bodyLines: string[] = [];
		let j = fileLevelItem.bodyStartIdx;

		// Collect all body content. Heading-level TODO items found below will
		// be parsed separately and registered as children; they are NOT part
		// of the file-level body.
		//
		// We do a first pass to find where body ends (first heading-level TODO
		// item), then a second pass in the heading parser to collect those items.
		// Actually, it's simpler to collect the entire remaining content as the
		// body and let callers decide. The heading-level items also appear in
		// the items list for query/dashboard purposes.
		while (j < lines.length) {
			bodyLines.push(lines[j]);
			j++;
		}

		// Trim trailing blank lines
		while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
			bodyLines.pop();
		}

		items.push({
			level: 0,
			state: fileLevelItem.state,
			title: fileLevelItem.title,
			lineNum: 1,
			properties: fileLevelItem.properties,
			bodyLines,
			childIndices: [],
		});

		headingScanStart = fileLevelItem.bodyStartIdx;
	}

	// Parse heading-level items
	const stack: Array<{ item: ParsedItem; index: number }> = [];

	let i = headingScanStart;
	while (i < lines.length) {
		const line = lines[i];
		const heading = parseHeadingLine(line, i + 1, todoKeywords);

		if (heading !== null) {
			// Only collect items with a TODO state
			if (heading.state !== null) {
				const item: ParsedItem = {
					level: heading.level,
					state: heading.state,
					title: heading.title,
					lineNum: heading.lineNum,
					properties: {},
					bodyLines: [],
					childIndices: [],
				};

				// Parse PROPERTIES drawer immediately following the heading
				let j = i + 1;
				if (j < lines.length && lines[j].trim() === ":PROPERTIES:") {
					j++;
					while (j < lines.length && lines[j].trim() !== ":END:") {
						const propMatch = /^\s*:([^:]+):\s*(.*)$/.exec(lines[j]);
						if (propMatch) {
							item.properties[propMatch[1].trim()] = propMatch[2].trim();
						}
						j++;
					}
					if (j < lines.length) j++; // skip :END:
				}

				// Collect body lines until the next heading (any level).
				while (j < lines.length) {
					const nextHeading = parseHeadingLine(lines[j], j + 1, todoKeywords);
					// Stop at any heading — sub-headings are processed as separate items by the outer loop,
					// not folded into the parent's body text.
					if (nextHeading !== null) break;
					item.bodyLines.push(lines[j]);
					j++;
				}

				// Trim trailing blank lines from body
				while (item.bodyLines.length > 0 && item.bodyLines[item.bodyLines.length - 1].trim() === "") {
					item.bodyLines.pop();
				}

				const itemIndex = items.length;
				items.push(item);

				// Update hierarchy
				while (stack.length > 0 && stack[stack.length - 1].item.level >= heading.level) {
					stack.pop();
				}
				if (stack.length > 0) {
					stack[stack.length - 1].item.childIndices.push(itemIndex);
				} else if (fileLevelItem && items.length > 1) {
					// Top-level heading items are children of the file-level item
					items[0].childIndices.push(itemIndex);
				}
				stack.push({ item, index: itemIndex });

				i = j;
				continue;
			} else {
				// Non-task heading: still affects the stack for hierarchy
				while (stack.length > 0 && stack[stack.length - 1].item.level >= heading.level) {
					stack.pop();
				}
			}
		}

		i++;
	}

	return items;
}

// =============================================================================
// Public API
// =============================================================================

export interface ReadOrgFileOptions {
	/** Absolute path to the .org file. */
	filePath: string;
	/** Category logical name. */
	category: string;
	/** Org dir logical name. */
	dir: string;
	/** Known TODO keywords. */
	todoKeywords: string[];
	/** Include body text in results. Default false. */
	includeBody?: boolean;
}

/**
 * Read all task items from a single .org file.
 */
export async function readOrgFile(opts: ReadOrgFileOptions): Promise<OrgItem[]> {
	let content: string;
	try {
		content = await Bun.file(opts.filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const keywords = new Set(opts.todoKeywords);
	const parsed = parseOrgFile(content, keywords);

	return parsed.map(
		(p): OrgItem => ({
			id: p.properties.CUSTOM_ID ?? "",
			title: p.title,
			state: p.state ?? "",
			category: opts.category,
			dir: opts.dir,
			file: opts.filePath,
			line: p.lineNum,
			level: p.level,
			properties: p.properties,
			body: opts.includeBody ? p.bodyLines.join("\n") : undefined,
		}),
	);
}

/**
 * Read all task items from every .org file in a category directory.
 */
export async function readCategory(
	categoryAbsPath: string,
	category: string,
	dir: string,
	todoKeywords: string[],
	includeBody = false,
): Promise<OrgItem[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(categoryAbsPath);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const orgFiles = entries.filter(e => e.endsWith(".org") && e !== "reference.org");

	const results = await Promise.all(
		orgFiles.map(file =>
			readOrgFile({
				filePath: path.join(categoryAbsPath, file),
				category,
				dir,
				todoKeywords,
				includeBody,
			}),
		),
	);

	return results.flat();
}

/**
 * Apply query filters to a list of items.
 */
export function applyFilter(items: OrgItem[], filter: OrgQueryFilter): OrgItem[] {
	return items.filter(item => {
		if (filter.state) {
			const states = Array.isArray(filter.state) ? filter.state : [filter.state];
			if (!states.includes(item.state)) return false;
		}
		if (filter.category) {
			const cats = Array.isArray(filter.category) ? filter.category : [filter.category];
			if (!cats.includes(item.category)) return false;
		}
		if (filter.dir) {
			const dirs = Array.isArray(filter.dir) ? filter.dir : [filter.dir];
			if (!dirs.includes(item.dir)) return false;
		}
		if (filter.priority) {
			const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
			const itemPriority = item.properties.PRIORITY;
			if (!itemPriority || !priorities.includes(itemPriority)) return false;
		}
		if (filter.layer) {
			const layers = Array.isArray(filter.layer) ? filter.layer : [filter.layer];
			const itemLayer = item.properties.LAYER;
			if (!itemLayer || !layers.includes(itemLayer)) return false;
		}
		if (filter.agent) {
			const itemAgent = item.properties.AGENT;
			if (itemAgent !== filter.agent) return false;
		}
		return true;
	});
}

/**
 * Find a single item by CUSTOM_ID across multiple category directories.
 *
 * Scans all provided category directories and returns the first match.
 * When Emacs is available, prefer the Emacs-backed path.
 */
export async function findItemById(
	categoryDirs: Array<{ absPath: string; name: string; dir: string }>,
	customId: string,
	todoKeywords: string[],
): Promise<OrgItem | undefined> {
	for (const cat of categoryDirs) {
		const items = await readCategory(cat.absPath, cat.name, cat.dir, todoKeywords, true);
		const found = items.find(item => item.id === customId);
		if (found) return found;
	}
	return undefined;
}
