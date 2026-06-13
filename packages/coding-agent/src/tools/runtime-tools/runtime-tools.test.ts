import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ToolSession } from "../index";
import { loadRuntimeTools } from "./loader";
import { deriveSkeleton, resolvePolicy } from "./policy";
import { composeToolSource, RuntimeToolDispatcher } from "./runtime";
import { createRuntimeTools } from "./session";
import type { ToolDescriptor } from "./types";

const BUILTIN = path.join(import.meta.dir, "builtin");
const gitPath = path.join(BUILTIN, "git.ptc");

// ---- Pure policy logic (no BEAM) ----

describe("resolvePolicy (drift-proof)", () => {
	const desc: ToolDescriptor = {
		name: "git",
		verbs: {
			log: { class: "read", args: null },
			commit: { class: "write", args: null },
			reset: { class: "destructive", args: null },
		},
	};

	it("applies class defaults when KDL omits a verb (read/write→silent)", () => {
		const { policy, errors } = resolvePolicy(desc, { reset: { gate: "confirm" } });
		expect(errors).toEqual([]);
		expect(policy.verbs.log.gate).toBe("silent");
		expect(policy.verbs.commit.gate).toBe("silent");
		expect(policy.verbs.reset.gate).toBe("confirm");
	});

	it("rejects a KDL verb the interface does not declare (phantom policy)", () => {
		const { errors } = resolvePolicy(desc, { reset: { gate: "confirm" }, nonexistent: { gate: "warn" } });
		expect(errors.some(e => e.includes("nonexistent"))).toBe(true);
	});

	it("auto-derives a destructive verb's gate from its class when KDL omits it", () => {
		// PLAN-337 Phase 2: a missing gate is DERIVED from :class (no fail-loud).
		const { policy, errors } = resolvePolicy(desc, {});
		expect(errors).toEqual([]);
		expect(policy.verbs.reset.gate).toBe("confirm"); // destructive default
		expect(policy.verbs.log.gate).toBe("silent");
	});

	it("rejects an invalid gate value", () => {
		const { errors } = resolvePolicy(desc, { reset: { gate: "yolo" } });
		expect(errors.some(e => e.includes("invalid gate"))).toBe(true);
	});

	it("accepts a KDL override that downgrades a destructive verb to warn", () => {
		const { policy, errors } = resolvePolicy(desc, { reset: { gate: "warn" } });
		expect(errors).toEqual([]);
		expect(policy.verbs.reset.gate).toBe("warn");
	});
});

describe("deriveSkeleton", () => {
	it("emits a verb line per interface verb at its class-default gate", () => {
		const skel = deriveSkeleton({
			name: "git",
			verbs: { log: { class: "read", args: null }, reset: { class: "destructive", args: null } },
		});
		expect(skel).toContain("git {");
		expect(skel).toContain('verb "log" { gate "silent" }');
		expect(skel).toContain('verb "reset" { gate "confirm" }');
	});
});

// ---- Live BEAM dispatch (real runtime) ----

describe("RuntimeToolDispatcher + git.ptc", () => {
	it("describes git verbs with their classes", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			const src = composeToolSource(await Bun.file(gitPath).text());
			const desc = await d.describe(src);
			expect(desc.name).toBe("git");
			expect(desc.verbs.log.class).toBe("read");
			expect(desc.verbs.commit.class).toBe("write");
			expect(desc.verbs.reset.class).toBe("destructive");
		} finally {
			d.close();
		}
	}, 60_000);

	it("builds argv for a verb (beat 1), honouring optional args", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			const src = composeToolSource(await Bun.file(gitPath).text());
			expect(await d.argv(src, "log", { n: 5 })).toEqual([
				"git",
				"log",
				"-5",
				"--pretty=format:%H%x09%an%x09%aI%x09%s",
			]);
			expect(await d.argv(src, "log", { n: 3, path: "src/" })).toEqual([
				"git",
				"log",
				"-3",
				"--pretty=format:%H%x09%an%x09%aI%x09%s",
				"--",
				"src/",
			]);
		} finally {
			d.close();
		}
	}, 60_000);

	it("parses raw stdout into structured data (beat 3)", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			const src = composeToolSource(await Bun.file(gitPath).text());
			const log = (await d.parse(src, "log", "h1\tAlice\t2026\tfix bug")) as Array<Record<string, string>>;
			expect(log[0]).toEqual({ hash: "h1", author: "Alice", date: "2026", subject: "fix bug" });
			const status = (await d.parse(src, "status", " M foo.ts\n?? bar.ts")) as { clean: boolean; files: unknown[] };
			expect(status.clean).toBe(false);
			expect(status.files).toEqual([
				{ status: " M", path: "foo.ts" },
				{ status: "??", path: "bar.ts" },
			]);
		} finally {
			d.close();
		}
	}, 60_000);
});

describe("loadRuntimeTools", () => {
	it("loads git with a valid policy and rejects nothing", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			const { tools, errors } = await loadRuntimeTools(
				[
					{
						path: gitPath,
						policy: { reset: { gate: "confirm" }, checkout: { gate: "confirm" }, raw: { gate: "warn" } },
					},
				],
				d,
			);
			expect(errors).toEqual([]);
			expect(tools).toHaveLength(1);
			expect(tools[0].descriptor.name).toBe("git");
			expect(tools[0].policy.verbs.reset.gate).toBe("confirm");
		} finally {
			d.close();
		}
	}, 60_000);

	it("loads a tool with no KDL policy, auto-deriving gates from :class", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			// No policy at all → git's destructive verbs auto-derive to confirm.
			const { tools, errors } = await loadRuntimeTools([{ path: gitPath }], d);
			expect(errors).toEqual([]);
			expect(tools).toHaveLength(1);
			expect(tools[0].policy.verbs.reset.gate).toBe("confirm");
			expect(tools[0].policy.verbs.status.gate).toBe("silent");
		} finally {
			d.close();
		}
	}, 60_000);
});

describe("createRuntimeTools (session wiring)", () => {
	// Minimal session stub: createRuntimeTools + makeRuntimeTool only touch cwd
	// and sandboxPolicy (at execute time).
	const session = { cwd: process.cwd(), sandboxPolicy: undefined } as unknown as ToolSession;

	it("loads the built-in git and run tools with bundled sources", async () => {
		const { tools, dispose } = await createRuntimeTools(session);
		try {
			const names = tools.map(t => t.name).sort();
			expect(names).toEqual(["git", "run"]);
			// Verbs surface in the description so the model can discover them.
			const git = tools.find(t => t.name === "git");
			expect(git?.description).toContain("log");
			expect(git?.description).toContain("status");
		} finally {
			dispose();
		}
	}, 60_000);

	it("runs git status end-to-end and returns structured data", async () => {
		const { tools, dispose } = await createRuntimeTools(session);
		try {
			const git = tools.find(t => t.name === "git");
			expect(git).toBeDefined();
			const res = await git!.execute("c1", { verb: "status" }, undefined, undefined, {} as never);
			expect(res.isError).toBeFalsy();
			// status parser → { clean: bool, files: [...] }
			expect(res.data).toHaveProperty("clean");
			expect(res.data).toHaveProperty("files");
		} finally {
			dispose();
		}
	}, 60_000);

	it("rejects an unknown verb with the available list", async () => {
		const { tools, dispose } = await createRuntimeTools(session);
		try {
			const git = tools.find(t => t.name === "git");
			await expect(git!.execute("c1", { verb: "nope" }, undefined, undefined, {} as never)).rejects.toThrow(
				/unknown verb/,
			);
		} finally {
			dispose();
		}
	}, 60_000);
});

describe("advisory gates (alignment over security)", () => {
	const session = { cwd: process.cwd(), sandboxPolicy: undefined } as unknown as ToolSession;

	it("a confirm-gated verb RUNS (does not block) and is flagged with details.warn + a note", async () => {
		const { tools, dispose } = await createRuntimeTools(session);
		try {
			const git = tools.find(t => t.name === "git");
			// `diff --cached` against a clean index is harmless; but its gate is read.
			// Use `log` (silent) vs a destructive verb to assert advisory behaviour:
			// run `reset` with a no-op ref so nothing actually changes, but it is
			// gated confirm → must still execute and be flagged.
			const res = await git!.execute(
				"c1",
				{ verb: "reset", args: { ref: "HEAD" } },
				undefined,
				undefined,
				{} as never,
			);
			// It ran (reset HEAD is a no-op on a repo) and is flagged, not blocked.
			expect((res.details as { warn?: boolean }).warn).toBe(true);
			expect((res.content[0] as { text: string }).text).toContain("would require confirmation");
		} finally {
			dispose();
		}
	}, 60_000);
});
