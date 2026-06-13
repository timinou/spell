/**
 * Precomputed descriptors for the built-in runtime tools (PLAN-337).
 *
 * These mirror exactly what `(rt-describe)` returns for `git.ptc` / `run.ptc`.
 * Embedding them lets the loader skip the BEAM `describe` call at session
 * startup — the dispatcher is only spawned lazily on the first verb invocation,
 * so an idle session pays no runtime-tool cost. `runtime-tools.test.ts` has a
 * drift test that re-derives these from the `.ptc` and asserts equality, so they
 * can never silently diverge.
 */
import type { ToolDescriptor } from "../types";

export const GIT_DESCRIPTOR: ToolDescriptor = {
	name: "git",
	doc: "Structured git operations",
	verbs: {
		status: { class: "read", args: null },
		log: { class: "read", args: { n: { type: "int", default: 20 }, path: { type: "str", optional: true } } },
		diff: {
			class: "read",
			args: { staged: { type: "bool", optional: true }, path: { type: "str", optional: true } },
		},
		show: { class: "read", args: { ref: { type: "str", default: "HEAD" } } },
		branch: { class: "read", args: null },
		add: { class: "write", args: { paths: { type: "list" } } },
		commit: { class: "write", args: { message: { type: "str" } } },
		reset: {
			class: "destructive",
			args: { ref: { type: "str", default: "HEAD" }, hard: { type: "bool", optional: true } },
		},
		checkout: { class: "destructive", args: { ref: { type: "str" }, force: { type: "bool", optional: true } } },
		raw: { class: "destructive", args: { argv: { type: "list" } } },
	},
};

export const RUN_DESCRIPTOR: ToolDescriptor = {
	name: "run",
	doc: "Run curated build/test/lint commands",
	verbs: {
		cargo: { class: "write", args: { args: { type: "list" } } },
		bun: { class: "write", args: { args: { type: "list" } } },
		mix: { class: "write", args: { args: { type: "list" } } },
		npm: { class: "write", args: { args: { type: "list" } } },
		exec: { class: "write", args: { argv: { type: "list" } } },
	},
};
