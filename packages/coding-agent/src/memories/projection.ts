import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@spell/pi-natives";
import Handlebars from "handlebars";
import sessionStartTemplate from "../prompts/memories/session-start.md.hbs" with { type: "text" };
import { peekMemoryProgress } from "../tools/memory";
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
// === STARTUP-DBG (BUG: blank screen after migration prompt). Disable with SPELL_STARTUP_DBG=0. ===
function _dbg(step: string, ctx?: Record<string, unknown>): void {
	if (process.env.SPELL_STARTUP_DBG !== "1") return;
	try {
		const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
		process.stderr.write(`[STARTUP-DBG proj] ${step}${ctxStr}\n`);
	} catch {}
}
export async function renderSessionStartSummary(cwd: string): Promise<string> {
	// === Dev escape hatch (PI_SKIP_SESSION_START_PROJECTION=1) ===
	// `executeOrg(recall)` is a synchronous N-API call that internally spawns the
	// pi-knowledge-worker and waits for an embedding-batch response. A stuck or
	// model-loading worker freezes the Bun event loop — blocking *all* startup,
	// including TUI render. Until the worker handshake gets a hard deadline in
	// Rust, set this env var to bypass the projection during local development
	// of the recall/embedding stack.
	if (process.env.PI_SKIP_SESSION_START_PROJECTION === "1") {
		_dbg("renderSessionStartSummary:SKIPPED (PI_SKIP_SESSION_START_PROJECTION=1)");
		return "";
	}
	_dbg("renderSessionStartSummary:enter", { cwd });

	// PLAN-316: if the recall daemon hasn't finished warming for this repo,
	// skip the synchronous recall (would block startup for 1–4 min on a cold
	// cache). The MemoryStatusController surfaces "indexing…" in the status
	// line; next session-start will get hits. peekMemoryProgress is cheap
	// (atomic read on the daemon) and falls back to "warm" when the daemon
	// is unreachable so we never accidentally skip the recall.
	// PLAN-316: skip the synchronous recall when:
	//   - the daemon is mid-warm (`warming` / `cold`): would block until
	//     warm-load finishes, 1–4 min on a cold corpus, and
	//   - the daemon hasn't been initialised yet (`unavailable`): forcing
	//     the recall here would load the bge-m3 model (5–30 s) just for
	//     the projection. Defer that to the first user-initiated memory
	//     call where the wait is expected and onUpdate keeps the TUI live.
	const progress = await peekMemoryProgress(cwd);
	let recallRes: Awaited<ReturnType<typeof executeOrg>>;
	const skipStatuses = new Set(["warming", "cold", "unavailable", "error"]);
	if (skipStatuses.has(progress.status)) {
		_dbg("skip:executeOrg recall", { progress });
		recallRes = { error: false, output: { hits: [] } };
	} else {
		_dbg("before:executeOrg recall");
		recallRes = await executeOrg({
			command: "recall",
			profile: "session-start",
			scope: ["concept"],
			limit: 12,
			repoRoot: cwd,
		});
		_dbg("after:executeOrg recall", { hasError: !!(recallRes as { error?: unknown })?.error });
	}
	_dbg("before:executeOrg query DOING/TODO");
	const queryRes = await executeOrg({
		command: "query",
		todoKeywords: ["DOING", "TODO"],
		limit: 5,
		repoRoot: cwd,
	});
	_dbg("after:executeOrg query DOING/TODO");
	_dbg("before:executeOrg query episode");
	const recentRes = await executeOrg({
		command: "query",
		kind: "episode",
		limit: 3,
		repoRoot: cwd,
	});
	_dbg("after:executeOrg query episode");

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
