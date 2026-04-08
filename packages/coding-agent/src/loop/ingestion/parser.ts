import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ParsedSpecFile {
	path: string;
	content: string;
	customIds: string[];
	links: string[];
}

async function collectOrgFiles(rootDir: string): Promise<string[]> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectOrgFiles(absPath)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".org")) {
			files.push(absPath);
		}
	}
	return files;
}

export async function parseSpecDirectory(rootDir: string): Promise<ParsedSpecFile[]> {
	const files = await collectOrgFiles(rootDir);
	const parsed: ParsedSpecFile[] = [];
	for (const filePath of files) {
		const content = await Bun.file(filePath).text();
		const customIds = Array.from(content.matchAll(/CUSTOM_ID:\s*([A-Za-z0-9_-]+)/g))
			.map(match => match[1] ?? "")
			.filter(Boolean);
		const links = Array.from(content.matchAll(/\[\[id:([^\]]+)\](?:\[[^\]]*\])?\]/g))
			.map(match => match[1] ?? "")
			.filter(Boolean);
		parsed.push({ path: filePath, content, customIds, links });
	}
	return parsed;
}
