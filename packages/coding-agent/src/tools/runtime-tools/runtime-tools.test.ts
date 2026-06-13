import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadRuntimeTools } from "./loader";
import { deriveSkeleton, resolvePolicy } from "./policy";
import { composeToolSource, RuntimeToolDispatcher } from "./runtime";
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

	it("rejects a destructive verb with no explicit gate (ungoverned risk)", () => {
		const { errors } = resolvePolicy(desc, {}); // reset is destructive, ungoverned
		expect(errors.some(e => e.includes("reset") && e.includes("explicit gate"))).toBe(true);
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

	it("rejects a tool whose destructive verbs are ungoverned (fail-loud)", async () => {
		const d = new RuntimeToolDispatcher();
		try {
			// No policy at all → git's destructive verbs (reset/checkout/raw) are ungoverned.
			const { tools, errors } = await loadRuntimeTools([{ path: gitPath }], d);
			expect(tools).toHaveLength(0);
			expect(errors).toHaveLength(1);
			expect(errors[0].error).toContain("explicit gate");
		} finally {
			d.close();
		}
	}, 60_000);
});
