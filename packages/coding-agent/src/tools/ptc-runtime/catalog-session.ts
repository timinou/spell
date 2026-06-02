/**
 * Session-backed ToolProvider for the `execute` tool.
 *
 * Instantiates the program-callable builtin tools once, exposing:
 *   - `catalogTools()` — name + parameters schema for catalog generation,
 *   - `lookup(name)`   — the runnable instance for the bridge dispatcher.
 *
 * Tools on the denylist (recursion/interactive/completion) and tools that fail
 * to instantiate (e.g. require capabilities the session lacks) are skipped, so a
 * program simply cannot see them. The capability policy (effects) is applied by
 * the caller on top of this set.
 */

import { BUILTIN_TOOLS, type ToolSession } from "../index";
import type { CatalogTool } from "./catalog-gen";
import { DEFAULT_DENYLIST, type DispatchableTool, type ToolProvider } from "./tool-dispatch";

export type { ToolProvider };

/**
 * Build a ToolProvider from a session by instantiating the builtin tool
 * factories. Instantiation is eager (once) and memoized; failures are silently
 * skipped (the tool is simply unavailable to programs).
 */
export function buildSessionToolProvider(session?: ToolSession): {
	catalogTools(): CatalogTool[];
	lookup(name: string): DispatchableTool | undefined;
} {
	const instances = instantiate(session);

	return {
		catalogTools(): CatalogTool[] {
			return [...instances.values()].map(t => ({
				name: t.name,
				description: typeof t.description === "string" ? t.description : undefined,
				parameters: t.parameters,
			}));
		},
		lookup(name: string): DispatchableTool | undefined {
			if (DEFAULT_DENYLIST.has(name)) return undefined;
			return instances.get(name);
		},
	};
}

/** A tool instance with the fields the provider needs (structural subset). */
interface InstantiatedTool extends DispatchableTool {
	description?: unknown;
	parameters?: CatalogTool["parameters"];
}

/** Instantiate program-callable builtin tools; skip denied + failing ones. */
function instantiate(session?: ToolSession): Map<string, InstantiatedTool> {
	const out = new Map<string, InstantiatedTool>();
	if (!session) return out;

	for (const [name, factory] of Object.entries(BUILTIN_TOOLS)) {
		if (DEFAULT_DENYLIST.has(name)) continue;
		try {
			const created = factory(session);
			// Factories may return a promise or null; we only take sync, non-null
			// tools for the catalog (async-only tools are rare and can be added
			// later via an async provider variant).
			if (created && !(created instanceof Promise)) {
				out.set(name, created as unknown as InstantiatedTool);
			}
		} catch {
			// Tool requires capabilities this session lacks — skip it.
		}
	}

	return out;
}
