/**
 * Catalog drift check — the `check:catalog` CI gate.
 *
 * The catalog is generated at runtime from instantiated session tools (see the
 * `execute` tool, P3), so there is no committed artifact to diff. The invariant
 * worth gating is instead the POLICY surface: every registered builtin tool must
 * have a deliberate effect tag in `effects.ts`. A new tool added to
 * `BUILTIN_TOOLS` without a tag would silently fall to the `exec` default and be
 * denied — or, worse, mis-classified. This check forces the author to decide.
 *
 * Run via `bun run check:catalog` (wired in package.json). Exits non-zero and
 * prints the offending tool names when any builtin lacks an explicit effect.
 *
 * Intentionally excluded: tools on the PtcRuntime denylist (they are never
 * reachable from a program, so their effect is moot) and pure-UI/agent-loop
 * tools that a program cannot meaningfully call.
 */

import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "../index";
import { DEFAULT_DENYLIST } from "./tool-dispatch";
import { TOOL_EFFECTS } from "./effects";

/** All registered tool names (builtin + hidden). */
const ALL_TOOL_NAMES = new Set<string>([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)]);

/** Tools excluded from the effect-tag requirement (not program-callable). */
const EXEMPT: ReadonlySet<string> = new Set<string>([
	...DEFAULT_DENYLIST,
	// UI / agent-loop / lifecycle tools a PTC program cannot drive:
	"render_mermaid",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"cancel_job",
	"await",
	"search_tool_bm25",
	"goals",
	"approvals",
	"send_file",
	"canvas",
	"canvas_cast",
	"manage", // legacy alias
]);

/** Compute the set of builtin tools missing an explicit effect tag. */
export function findUntaggedTools(): string[] {
	const tagged = new Set(Object.keys(TOOL_EFFECTS));
	return Object.keys(BUILTIN_TOOLS)
		.filter(name => !EXEMPT.has(name))
		.filter(name => !tagged.has(name))
		.sort();
}

/** Internal: re-exported for tests. */
export { ALL_TOOL_NAMES };

/** Tools that have an effect tag but are no longer registered (stale entries). */
export function findStaleEffectTags(): string[] {
	return Object.keys(TOOL_EFFECTS)
		.filter(name => !ALL_TOOL_NAMES.has(name))
		.sort();
}

/** Run the check; return a human-readable report and an ok flag. */
export function runCatalogCheck(): { ok: boolean; report: string } {
	const untagged = findUntaggedTools();
	const stale = findStaleEffectTags();
	const ok = untagged.length === 0 && stale.length === 0;

	const lines: string[] = [];
	if (untagged.length > 0) {
		lines.push(
			`✗ ${untagged.length} builtin tool(s) lack an effect tag in effects.ts (TOOL_EFFECTS):`,
			...untagged.map(n => `    - ${n}`),
			`  Add each to TOOL_EFFECTS with a deliberate effect (pure|read|write|exec|network),`,
			`  or add to EXEMPT in catalog-check.ts if it is not program-callable.`,
		);
	}
	if (stale.length > 0) {
		lines.push(
			`✗ ${stale.length} effect tag(s) reference tools not in BUILTIN_TOOLS:`,
			...stale.map(n => `    - ${n}`),
			`  Remove the stale entries from TOOL_EFFECTS.`,
		);
	}
	if (ok) lines.push("✓ catalog effect tags are in sync with BUILTIN_TOOLS");

	return { ok, report: lines.join("\n") };
}

// CLI entrypoint.
if (import.meta.main) {
	const { ok, report } = runCatalogCheck();
	// biome-ignore lint/suspicious/noConsole: CLI gate output
	console.log(report);
	process.exit(ok ? 0 : 1);
}
