/**
 * Session wiring for runtime tools (PLAN-337 Phase 1b).
 *
 * Loads the built-in `deftool` interfaces (git, run), applies their default KDL
 * policy, and synthesizes the `AgentTool`s. The dispatcher is created lazily and
 * shared across the loaded tools, and disposed when the session ends.
 *
 * Default policy ships in-code here (the KDL skeleton a user would get from
 * `spell tools sync`); a project's `spell.kdl` can override per verb later. The
 * built-in defaults govern every destructive verb explicitly so the fail-loud
 * loader accepts them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@spell/pi-agent-core";
import { getProjectAgentDir, getToolsDir } from "@spell/pi-utils";
import type { ToolSession } from "../index";
import { GIT_DESCRIPTOR, RUN_DESCRIPTOR } from "./builtin/descriptors";
import gitPtc from "./builtin/git.ptc" with { type: "text" };
import runPtc from "./builtin/run.ptc" with { type: "text" };
import { readRuntimeToolPolicies } from "./kdl-policy";
import { loadRuntimeTools, type RuntimeToolSource } from "./loader";
import type { RawToolPolicy } from "./policy";
import { RuntimeToolDispatcher } from "./runtime";
import { makeRuntimeTool } from "./tool";
import type { ToolDescriptor } from "./types";

/** A built-in interface plus its default per-verb policy + static descriptor. */
interface BuiltinRuntimeTool {
	name: string;
	source: string;
	policy: RawToolPolicy;
	/**
	 * Precomputed descriptor so loading a built-in costs NO BEAM spawn at session
	 * startup (the dispatcher spawns lazily on the first verb call). Must match
	 * what `(rt-describe)` returns for `source`; a drift test enforces this.
	 */
	descriptor: ToolDescriptor;
}

/**
 * The shipped built-ins. Default gates:
 *   read/write → silent · git destructive → confirm (shared-worktree safety)
 *   · escape verbs (git raw / run exec) → warn (observe usage).
 */
const BUILTINS: BuiltinRuntimeTool[] = [
	{
		name: "git",
		source: gitPtc,
		descriptor: GIT_DESCRIPTOR,
		policy: {
			reset: { gate: "confirm" },
			checkout: { gate: "confirm" },
			raw: { gate: "warn" },
		},
	},
	{
		name: "run",
		source: runPtc,
		descriptor: RUN_DESCRIPTOR,
		// `run` has no destructive verbs; the escape `exec` is warn (observe).
		policy: {
			exec: { gate: "warn" },
		},
	},
];

/** A loaded runtime-tool set bound to its dispatcher, for disposal. */
export interface RuntimeToolSet {
	tools: AgentTool[];
	dispose(): void;
}

/**
 * Build the runtime tools for a session. Returns an empty set (and disposes the
 * dispatcher) when none load. The caller appends `tools` to the session toolset.
 */
export async function createRuntimeTools(session: ToolSession): Promise<RuntimeToolSet> {
	const dispatcher = new RuntimeToolDispatcher();

	// Per-verb gate overrides from spell.kdl (PLAN-337 Phase 2.5), merged over the
	// built-in defaults below. A user's `runtime-tools { git { verb "reset"
	// gate="warn" } }` wins per verb; resolvePolicy fills the rest from :class.
	const kdlPolicies = await readRuntimeToolPolicies(session.cwd).catch(() => ({}));

	// Built-ins are bundled as text; user/project tools are discovered on disk.
	// Both flow through the same loader (describe → resolvePolicy). A user tool
	// with the same name as a built-in OVERRIDES it (project > user > built-in).
	const builtinSources: RuntimeToolSource[] = BUILTINS.map(b => ({
		path: `<builtin>/${b.name}.ptc`,
		policy: b.policy,
		precomputedDescriptor: b.descriptor,
	}));
	const builtinText = new Map(BUILTINS.map((b, i) => [builtinSources[i].path, b.source]));

	const discovered = await discoverUserToolSources(session.cwd);
	const diskText = new Map(discovered.map(d => [d.source.path, d.text]));
	const readSource = (p: string): string | undefined => builtinText.get(p) ?? diskText.get(p);

	// Later sources win on name collision: built-ins first, then user, then
	// project (discoverUserToolSources returns user-before-project). The KDL
	// per-verb gates are applied by tool NAME inside the loader (after describe),
	// so they override BOTH built-ins and user .ptc consistently.
	const allSources = [...builtinSources, ...discovered.map(d => d.source)];
	const { tools: loaded } = await loadRuntimeTools(allSources, dispatcher, readSource, kdlPolicies);

	// De-dupe by tool name, last-wins (so a project .ptc overrides a built-in).
	const byName = new Map<string, (typeof loaded)[number]>();
	for (const l of loaded) byName.set(l.descriptor.name, l);
	const tools = [...byName.values()].map(l => makeRuntimeTool(l, dispatcher, session));

	if (tools.length === 0) {
		dispatcher.close();
		return { tools: [], dispose: () => {} };
	}

	// The dispatcher is shared across these tools; close it when the session
	// disposes them. Attach to the first tool (dispatcher.close is idempotent).
	const dispose = () => dispatcher.close();
	tools[0].dispose = dispose;
	return { tools, dispose };
}

/**
 * Discover user/project `.ptc` interface files. Scans `~/.spell/agent/tools`
 * (user) then `<cwd>/.spell/tools` (project) — project last so it wins on a name
 * collision. No KDL policy here: gates auto-derive from each verb's :class
 * (resolvePolicy fills them), so a user just drops a `.ptc` and it works.
 */
async function discoverUserToolSources(cwd: string): Promise<Array<{ source: RuntimeToolSource; text: string }>> {
	const dirs = [getToolsDir(), path.join(getProjectAgentDir(cwd), "tools")];
	const out: Array<{ source: RuntimeToolSource; text: string }> = [];

	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue; // dir doesn't exist — fine
		}
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".ptc")) continue;
			const full = path.join(dir, entry);
			try {
				const text = await fs.readFile(full, "utf8");
				out.push({ source: { path: full }, text });
			} catch {
				// Unreadable file — skip.
			}
		}
	}
	return out;
}
