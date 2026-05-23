import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { clearRuntimeSchemes, executeCodePath } from "@oh-my-pi/pi-natives";
import type { AsyncJobManager } from "../src/async/job-manager";
import type { Rule } from "../src/capability/rule";
import type { Skill } from "../src/extensibility/skills";
import { setupCallbackSchemes, unregisterCallbackSchemes } from "../src/scheme-bootstrap";

/**
 * End-to-end: exercise the full callback bridge.
 *
 * setupCallbackSchemes() → registerSchemeCallback (napi) → JsTsfnCallback ←→
 * kernel SchemeRegistry → resolves URI → calls back into JS resolver →
 * returns to kernel → wraps as NodeRef → executeCodePath returns.
 *
 * If the bridge breaks, these tests catch it. If the resolver logic breaks,
 * scheme-bootstrap.test.ts catches it. If both pass, the cutover works.
 */

describe("callback bridge end-to-end", () => {
	afterEach(() => {
		// process-global registry; isolate between tests
		clearRuntimeSchemes();
	});

	it("rule:// resolves through bridge with sourcePath", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rule-e2e-"));
		try {
			const rulePath = path.join(tmp, "no-unwrap.md");
			await fs.writeFile(rulePath, "# No Unwrap\n\nForbid `.unwrap()`.\n");
			const rule: Rule = {
				name: "no-unwrap",
				path: rulePath,
				content: await fs.readFile(rulePath, "utf-8"),
				_source: { providerId: "native", sourcePath: rulePath, displayPath: rulePath },
			} as unknown as Rule;

			const errors = setupCallbackSchemes({
				getRules: () => [rule],
				getSkills: () => [],
				getAsyncJobManager: () => undefined,
			});
			expect(errors).toEqual([]);

			const chunks = await executeCodePath({
				command: "get",
				target: "rule://no-unwrap",
				root: tmp,
				home: "/home/u",
			});
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§rule");
			expect(node).toBeDefined();
			expect(node?.content?.value).toContain("No Unwrap");
			expect(node?.metadata?.source_path).toBe(rulePath);
		} finally {
			unregisterCallbackSchemes();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("skill:// resolves bare name to SKILL.md via bridge", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-e2e-"));
		try {
			const skillPath = path.join(tmp, "canvas/SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await fs.writeFile(skillPath, "# canvas skill\n");
			const skill: Skill = {
				name: "canvas",
				description: "canvas",
				filePath: skillPath,
				baseDir: path.dirname(skillPath),
				source: "native",
			};

			setupCallbackSchemes({
				getRules: () => [],
				getSkills: () => [skill],
				getAsyncJobManager: () => undefined,
			});

			const chunks = await executeCodePath({
				command: "get",
				target: "skill://canvas",
				root: tmp,
				home: "/home/u",
			});
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§skill");
			expect(node).toBeDefined();
			expect(node?.content?.value).toContain("canvas skill");
			expect(node?.metadata?.source_path).toBe(skillPath);
		} finally {
			unregisterCallbackSchemes();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("skill:// resolves sub-path via bridge", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-sub-e2e-"));
		try {
			const skillPath = path.join(tmp, "canvas/SKILL.md");
			const scriptPath = path.join(tmp, "canvas/scripts/init.py");
			await fs.mkdir(path.dirname(scriptPath), { recursive: true });
			await fs.writeFile(skillPath, "# c\n");
			await fs.writeFile(scriptPath, "print('hello')\n");
			const skill: Skill = {
				name: "canvas",
				description: "canvas",
				filePath: skillPath,
				baseDir: path.dirname(skillPath),
				source: "native",
			};

			setupCallbackSchemes({
				getRules: () => [],
				getSkills: () => [skill],
				getAsyncJobManager: () => undefined,
			});

			const chunks = await executeCodePath({
				command: "get",
				target: "skill://canvas/scripts/init.py",
				root: tmp,
				home: "/home/u",
			});
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§skill");
			expect(node?.content?.value).toContain("print");
			expect(node?.metadata?.source_path).toBe(scriptPath);
		} finally {
			unregisterCallbackSchemes();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("jobs:// resolves via bridge", async () => {
		const fakeMgr = {
			getAllJobs: () => [
				{ id: "j1", type: "bash" as const, status: "running" as const, startTime: Date.now() - 1000, label: "t" },
			],
			getJob: (id: string) => id === "j1"
				? { id: "j1", type: "bash" as const, status: "running" as const, startTime: Date.now() - 1000, label: "t" }
				: undefined,
		} as unknown as AsyncJobManager;

		setupCallbackSchemes({
			getRules: () => [],
			getSkills: () => [],
			getAsyncJobManager: () => fakeMgr,
		});

		try {
			const chunks = await executeCodePath({
				command: "get",
				target: "jobs://j1",
				root: "/tmp",
				home: "/home/u",
			});
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§jobs");
			expect(node).toBeDefined();
			expect(node?.content?.value).toContain("# Job j1");
			expect(node?.content?.value).toContain("status: running");
		} finally {
			unregisterCallbackSchemes();
		}
	});

	it("jobs://<id>#status returns plain status via bridge", async () => {
		const fakeMgr = {
			getAllJobs: () => [],
			getJob: () => ({ id: "j1", type: "bash" as const, status: "completed" as const, startTime: Date.now(), label: "t", resultText: "OUT" }),
		} as unknown as AsyncJobManager;

		setupCallbackSchemes({
			getRules: () => [],
			getSkills: () => [],
			getAsyncJobManager: () => fakeMgr,
		});

		try {
			const chunks = await executeCodePath({
				command: "get",
				target: "jobs://j1#status",
				root: "/tmp",
				home: "/home/u",
			});
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§jobs");
			expect(node?.content?.value).toBe("completed");
		} finally {
			unregisterCallbackSchemes();
		}
	});

	it("missing rule surfaces error diagnostic", async () => {
		setupCallbackSchemes({
			getRules: () => [],
			getSkills: () => [],
			getAsyncJobManager: () => undefined,
		});

		try {
			await expect(
				executeCodePath({
					command: "get",
					target: "rule://does-not-exist",
					root: "/tmp",
					home: "/home/u",
				}),
			).rejects.toThrow(/not found/);
		} finally {
			unregisterCallbackSchemes();
		}
	});
});
