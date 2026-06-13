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
import type { AgentTool } from "@spell/pi-agent-core";
import type { ToolSession } from "../index";
import gitPtc from "./builtin/git.ptc" with { type: "text" };
import runPtc from "./builtin/run.ptc" with { type: "text" };
import { loadRuntimeTools, type RuntimeToolSource } from "./loader";
import type { RawToolPolicy } from "./policy";
import { RuntimeToolDispatcher } from "./runtime";
import { makeRuntimeTool } from "./tool";

/** A built-in interface plus its default per-verb policy. */
interface BuiltinRuntimeTool {
	name: string;
	source: string;
	policy: RawToolPolicy;
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
		policy: {
			reset: { gate: "confirm" },
			checkout: { gate: "confirm" },
			raw: { gate: "warn" },
		},
	},
	{
		name: "run",
		source: runPtc,
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

	// The loader reads `.ptc` from disk; the built-ins are bundled as text, so we
	// load them via the in-memory path by writing through a tiny source shim.
	const sources: RuntimeToolSource[] = BUILTINS.map(b => ({ path: `<builtin>/${b.name}.ptc`, policy: b.policy }));
	const { tools: loaded, errors } = await loadRuntimeToolsFromSources(dispatcher, BUILTINS, sources);

	if (errors.length > 0) {
		// Surfaced by the loader's logger; a failed built-in is skipped, not fatal.
	}

	const tools = loaded.map(l => makeRuntimeTool(l, dispatcher, session));

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
 * Load built-ins whose source is already in memory (bundled text), reusing the
 * loader's describe + policy-resolution path without a filesystem read.
 */
async function loadRuntimeToolsFromSources(
	dispatcher: RuntimeToolDispatcher,
	builtins: BuiltinRuntimeTool[],
	sources: RuntimeToolSource[],
): ReturnType<typeof loadRuntimeTools> {
	// Reuse the on-disk loader by providing the bundled text through a source map.
	const byPath = new Map(builtins.map((b, i) => [sources[i].path, b.source]));
	return loadRuntimeTools(sources, dispatcher, path => byPath.get(path));
}
