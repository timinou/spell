/**
 * Shared types for `deftool` runtime tools (PLAN-337).
 *
 * A runtime tool is defined by a PTC-Lisp interface file (`<name>.ptc`) plus a
 * derived KDL policy block. The interface declares verbs; the policy gates them.
 */

/** Verb risk class — drives the default gate and the effects tag. */
export type VerbClass = "read" | "write" | "destructive";

/** What happens before a verb's process runs. */
export type Gate = "silent" | "warn" | "confirm" | "deny";

/** A single verb's metadata, as returned by the PTC `(rt-describe)` call. */
export interface VerbDescriptor {
	class: VerbClass;
	/** Arg schema map (opaque here; validated PTC-side). `null` when absent. */
	args: Record<string, unknown> | null;
}

/** The load-time descriptor of a tool's interface (no closures — those stay in the BEAM). */
export interface ToolDescriptor {
	name: string;
	doc?: string;
	verbs: Record<string, VerbDescriptor>;
}

/** Per-verb policy resolved from KDL (or `:class` defaults). */
export interface VerbPolicy {
	gate: Gate;
}

/** A tool's resolved policy: per-verb gates. */
export interface ToolPolicy {
	verbs: Record<string, VerbPolicy>;
}

/** The default gate for a verb class when no KDL override is present. */
export function defaultGate(verbClass: VerbClass): Gate {
	switch (verbClass) {
		case "read":
			return "silent";
		case "write":
			return "silent";
		case "destructive":
			// Destructive verbs default to confirm: in a shared worktree they can
			// destroy uncommitted work, so a warn-and-proceed default is unsafe.
			return "confirm";
	}
}

/** A loaded runtime tool: its interface source, descriptor, and resolved policy. */
export interface LoadedRuntimeTool {
	descriptor: ToolDescriptor;
	policy: ToolPolicy;
	/** The full PTC interface source (prelude + file), reused for every dispatch. */
	source: string;
	/** Absolute path of the `.ptc` file, for diagnostics. */
	path: string;
}
