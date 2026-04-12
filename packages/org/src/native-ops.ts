import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { MemoryEntry, OrgCreateParams, OrgItem, OrgSessionContext } from "./types";

interface ReadOrgFileOptions {
	filePath: string;
	category: string;
	dir: string;
	todoKeywords: string[];
	includeBody?: boolean;
}

export async function readOrgFile(opts: ReadOrgFileOptions): Promise<OrgItem[]> {
	const result = executeOrg({
		command: "parse",
		file: opts.filePath,
		category: opts.category,
		dir: opts.dir,
		todoKeywords: opts.todoKeywords,
		includeBody: opts.includeBody ?? false,
	});
	if (result.error) {
		try {
			await Bun.file(opts.filePath).text();
		} catch (err) {
			if (isEnoent(err)) return [];
		}
		throw new Error(String(result.output));
	}
	return ((result.output as { items?: OrgItem[] }).items ?? []) as OrgItem[];
}

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
	const orgFiles = entries.filter(entry => entry.endsWith(".org") && entry !== "reference.org");
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

export async function findItemById(
	categoryDirs: Array<{ absPath: string; name: string; dir: string }>,
	customId: string,
	todoKeywords: string[],
): Promise<OrgItem | undefined> {
	for (const category of categoryDirs) {
		const items = await readCategory(category.absPath, category.name, category.dir, todoKeywords, true);
		const found = items.find(item => item.id === customId);
		if (found) return found;
	}
	return undefined;
}

export async function appendItemToFile(
	filePath: string,
	params: OrgCreateParams & { id: string },
	state: string,
	session?: OrgSessionContext,
): Promise<string> {
	const result = executeOrg({
		command: "createItem",
		file: filePath,
		id: params.id,
		title: params.title,
		state,
		properties: params.properties,
		body: params.body,
		sessionId: session?.sessionId,
		transcriptPath: session?.transcriptPath,
		initialMessage: session?.initialMessage,
	});
	if (result.error) throw new Error(String(result.output));
	return filePath;
}

export async function updateItemStateInFile(
	filePath: string,
	customId: string,
	newState: string,
	todoKeywords: string[],
	note?: string,
): Promise<boolean> {
	const result = executeOrg({
		command: "updateItem",
		file: filePath,
		id: customId,
		state: newState,
		note,
		todoKeywords,
	});
	return !result.error;
}

export async function updateItemBodyInFile(
	filePath: string,
	customId: string,
	newBody: string | null,
	todoKeywords: string[],
): Promise<boolean> {
	const result = executeOrg({ command: "updateItem", file: filePath, id: customId, body: newBody, todoKeywords });
	return !result.error;
}

export async function appendToItemBodyInFile(
	filePath: string,
	customId: string,
	text: string,
	todoKeywords: string[],
): Promise<boolean> {
	const result = executeOrg({ command: "updateItem", file: filePath, id: customId, append: text, todoKeywords });
	return !result.error;
}

export async function setPropertyInFile(
	filePath: string,
	customId: string,
	property: string,
	value: string,
	todoKeywords: string[] = [],
): Promise<boolean> {
	const result = executeOrg({ command: "setProperty", file: filePath, id: customId, property, value, todoKeywords });
	return !result.error;
}

export function serializeMemoryEntry(entry: MemoryEntry): string {
	const scopeParts = entry.scope.split("/").filter(Boolean);
	const allTags = [...new Set([...scopeParts, ...(entry.tags ?? [])])];
	const tagStr = allTags.length > 0 ? `  :${allTags.join(":")}:` : "";
	const slug = entry.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const id = `MEM-${slug}`;
	const now = new Date();
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const dateStr = `[${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${days[now.getDay()]}]`;
	return [
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
	].join("\n");
}

export function serializeMemoryFile(entries: MemoryEntry[], sourceSession: string): string {
	const dateStr = new Date().toISOString().split("T")[0]!;
	const header = [
		"#+TITLE: Spell Long-Term Memory",
		`#+LAST_UPDATED: ${dateStr}`,
		`#+SOURCE_SESSION: ${sourceSession}`,
		"",
	].join("\n");
	return header + entries.map(serializeMemoryEntry).join("");
}
