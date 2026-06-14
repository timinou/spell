// FEAT-815 Phase C — pure helpers for the semantic code lens. A "lens" maps a
// base symbol/path to a CodePath `target` string resolved by pi-code-graph via
// the code_query RPC. No React here, so it is unit-testable headlessly.

export type LensKind = "callers" | "definition" | "implementers" | "baseTypes" | "type" | "diagnostics" | "outline";

export interface LensSpec {
	kind: LensKind;
	label: string;
	/** Short hint shown in the chip's title. */
	hint: string;
}

/** Available lenses, in display order. Surfaces pi-code-graph edges + LSP views. */
export const LENSES: LensSpec[] = [
	{ kind: "callers", label: "Callers", hint: "who calls this symbol (def→)" },
	{ kind: "definition", label: "Definition", hint: "jump to where it's defined (ref→)" },
	{ kind: "implementers", label: "Implementers", hint: "types implementing this (implements→)" },
	{ kind: "baseTypes", label: "Base types", hint: "what this extends/inherits (inherits→)" },
	{ kind: "type", label: "Type", hint: "hover type / signature (#hover)" },
	{ kind: "outline", label: "Outline", hint: "file symbol outline (#outline)" },
	{ kind: "diagnostics", label: "Diagnostics", hint: "errors & warnings (#diagnostics)" },
];

/**
 * Build a CodePath target for a lens over a base symbol/path. The base is a
 * raw CodePath locator the user typed (e.g. `src/foo.ts::Bar.method` or
 * `src/foo.ts`). Edge lenses append a graph traversal; view lenses append a
 * qualifier. Returns null for an empty base.
 */
export function buildLensTarget(base: string, kind: LensKind): string | null {
	const b = base.trim();
	if (!b) return null;
	switch (kind) {
		case "callers":
			return `${b} def→`;
		case "definition":
			return `${b} ref→`;
		case "implementers":
			return `${b} implements→`;
		case "baseTypes":
			return `${b} inherits→`;
		case "type":
			return `${b}#hover`;
		case "outline":
			return `${b}#outline`;
		case "diagnostics":
			return `${b}#diagnostics`;
	}
}

/** Format a node location as `path:line` (line optional). */
export function nodeLocation(node: { path?: string; line?: number }): string {
	if (!node.path) return "";
	return typeof node.line === "number" ? `${node.path}:${node.line}` : node.path;
}
