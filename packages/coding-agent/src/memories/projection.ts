import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";
import Handlebars from "handlebars";
import sessionStartTemplate from "../prompts/memories/session-start.md.hbs" with { type: "text" };
import { resolveGraphMemoryRoot } from "./layout";

const template = Handlebars.compile(sessionStartTemplate);

export interface SessionStartSummary {
	hits: unknown[];
	active: unknown[];
	recent: unknown[];
}

/**
 * Render the session-start memory_summary.md from a recall projection.
 * Writes to `<cwd>/.spell/memory/cache/memory_summary.md` and returns the rendered text.
 */
export async function renderSessionStartSummary(cwd: string): Promise<string> {
	const recallRes = executeOrg({
		command: "recall",
		profile: "session-start",
		scope: ["concept"],
		limit: 12,
		repoRoot: cwd,
	});
	const queryRes = executeOrg({
		command: "query",
		todoKeywords: ["DOING", "TODO"],
		limit: 5,
		repoRoot: cwd,
	});
	const recentRes = executeOrg({
		command: "query",
		kind: "episode",
		limit: 3,
		repoRoot: cwd,
	});

	const data: SessionStartSummary = {
		hits: extract(recallRes, "hits"),
		active: extract(queryRes, "items"),
		recent: extract(recentRes, "items"),
	};
	const rendered = template(data);

	const cacheDir = path.join(resolveGraphMemoryRoot(cwd), "cache");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(path.join(cacheDir, "memory_summary.md"), rendered, "utf8");
	return rendered;
}

function extract(res: any, key: string): unknown[] {
	if (!res || res.error || !res.output) return [];
	const v = res.output[key];
	return Array.isArray(v) ? v : [];
}
