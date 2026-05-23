import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AsyncJob, AsyncJobManager } from "../src/async/job-manager";
import type { Rule } from "../src/capability/rule";
import type { Skill } from "../src/extensibility/skills";
import { resolveJobs, resolveRule, resolveSkill } from "../src/scheme-bootstrap";

/**
 * Test the in-process resolver functions for rule/skill/jobs callback schemes
 * (PLAN-310 BUG-393/394/395). These verify the JS half of the bridge: kernel
 * calls back here, this fn returns SchemeResolveResult shape.
 */

function makeRule(name: string, content: string, p: string, source = "native"): Rule {
	return {
		name,
		path: p,
		content,
		_source: { providerId: source, sourcePath: p, displayPath: p },
	} as unknown as Rule;
}

function makeSkill(name: string, p: string, _content: string): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: p,
		baseDir: path.dirname(p),
		source: "native",
		_source: { providerId: "native", sourcePath: p, displayPath: p } as unknown as Skill["_source"],
	};
}

describe("resolveRule (BUG-393)", () => {
	it("returns the rule body + sourcePath for codepath forwarding", () => {
		const rules = [makeRule("no-unwrap", "# No unwrap\n\nForbid `.unwrap()`.\n", "/abs/.spell/rules/no-unwrap.md")];
		const r = resolveRule({ getRules: () => rules }, "no-unwrap");
		expect(r.url).toBe("rule://no-unwrap");
		expect(r.content).toContain("No unwrap");
		expect(r.sourcePath).toBe("/abs/.spell/rules/no-unwrap.md");
		expect(r.mime).toBe("text/markdown");
	});

	it("surfaces non-native source as a note", () => {
		const rules = [makeRule("from-cursor", "# Cursor rule\n", "/abs/.cursor/rules/x.mdc", "cursor")];
		const r = resolveRule({ getRules: () => rules }, "from-cursor");
		expect(r.notes).toEqual(["rule source: cursor"]);
	});

	it("omits notes for native rules", () => {
		const rules = [makeRule("builtin", "x", "/abs/.spell/rules/builtin.md")];
		const r = resolveRule({ getRules: () => rules }, "builtin");
		expect(r.notes).toEqual([]);
	});

	it("throws when rule not found with available list", () => {
		const rules = [makeRule("a", "x", "/a"), makeRule("b", "y", "/b")];
		expect(() => resolveRule({ getRules: () => rules }, "missing")).toThrow(/'missing' not found.*a, b/);
	});

	it("throws on empty body", () => {
		expect(() => resolveRule({ getRules: () => [] }, "")).toThrow(/rule name is required/);
	});
});

describe("resolveSkill (BUG-394)", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plan-310-skill-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("resolves bare skill name to SKILL.md", async () => {
		const skillPath = path.join(tmp, "canvas/SKILL.md");
		await fs.mkdir(path.dirname(skillPath), { recursive: true });
		await fs.writeFile(skillPath, "# canvas skill\n");
		const skills = [makeSkill("canvas", skillPath, "# canvas skill\n")];

		const r = resolveSkill({ getSkills: () => skills }, "canvas");
		expect(r.url).toBe("skill://canvas");
		expect(r.content).toContain("canvas skill");
		expect(r.sourcePath).toBe(skillPath);
		expect(r.mime).toBe("text/markdown");
	});

	it("resolves sub-paths under skill baseDir", async () => {
		const skillPath = path.join(tmp, "canvas/SKILL.md");
		const scriptPath = path.join(tmp, "canvas/scripts/init.py");
		await fs.mkdir(path.dirname(scriptPath), { recursive: true });
		await fs.writeFile(skillPath, "# canvas\n");
		await fs.writeFile(scriptPath, "print('hi')\n");
		const skills = [makeSkill("canvas", skillPath, "# canvas\n")];

		const r = resolveSkill({ getSkills: () => skills }, "canvas/scripts/init.py");
		expect(r.content).toContain("print");
		expect(r.sourcePath).toBe(scriptPath);
		expect(r.mime).toBe("text/x-python");
	});

	it("rejects path traversal escaping baseDir", async () => {
		const skillPath = path.join(tmp, "canvas/SKILL.md");
		const sibling = path.join(tmp, "secrets.txt");
		await fs.mkdir(path.dirname(skillPath), { recursive: true });
		await fs.writeFile(skillPath, "# canvas\n");
		await fs.writeFile(sibling, "SECRET");
		const skills = [makeSkill("canvas", skillPath, "# canvas\n")];

		expect(() => resolveSkill({ getSkills: () => skills }, "canvas/../secrets.txt"))
			.toThrow(/disallowed characters|escapes/);
	});

	it("rejects unknown skill with available list", () => {
		const skills = [makeSkill("a", "/a/SKILL.md", "x")];
		expect(() => resolveSkill({ getSkills: () => skills }, "missing")).toThrow(/'missing' not found.*a/);
	});

	it("throws on empty body", () => {
		expect(() => resolveSkill({ getSkills: () => [] }, "")).toThrow(/skill name is required/);
	});
});

// ───────────────────── jobs ─────────────────────────────────

function fakeJob(overrides: Partial<AsyncJob>): AsyncJob {
	return {
		id: "job-1",
		type: "bash",
		status: "running",
		startTime: Date.now() - 5000,
		label: "test job",
		abortController: new AbortController(),
		promise: Promise.resolve(),
		...overrides,
	} as AsyncJob;
}

function fakeManager(jobs: AsyncJob[]): AsyncJobManager {
	return {
		getAllJobs: () => jobs,
		getJob: (id: string) => jobs.find(j => j.id === id),
	} as unknown as AsyncJobManager;
}

describe("resolveJobs (BUG-395)", () => {
	it("returns disabled message when manager is undefined", () => {
		const r = resolveJobs({ getAsyncJobManager: () => undefined }, "");
		expect(r.content).toContain("Async execution is disabled");
	});

	it("lists all jobs when body is empty", () => {
		const mgr = fakeManager([fakeJob({ id: "a" }), fakeJob({ id: "b", status: "completed" })]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "");
		expect(r.content).toContain("`a`");
		expect(r.content).toContain("`b`");
		expect(r.content).toContain("2 jobs");
	});

	it("returns summary for a single job id", () => {
		const job = fakeJob({ id: "the-job", status: "completed", resultText: "42\n", endTime: Date.now() });
		const mgr = fakeManager([job]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "the-job");
		expect(r.content).toContain("# Job the-job");
		expect(r.content).toContain("status: completed");
		expect(r.content).toContain("42");
		expect(r.notes).toEqual(["status: completed"]);
	});

	it("returns single field with fragment suffix", () => {
		const job = fakeJob({ id: "j1", status: "running" });
		const mgr = fakeManager([job]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "j1#status");
		expect(r.content).toBe("running");
		expect(r.mime).toBe("text/plain");
	});

	it("returns result field via fragment", () => {
		const job = fakeJob({ id: "j1", status: "completed", resultText: "OUTPUT" });
		const mgr = fakeManager([job]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "j1#result");
		expect(r.content).toBe("OUTPUT");
	});

	it("returns 404 markdown for unknown id", () => {
		const mgr = fakeManager([]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "ghost");
		expect(r.content).toContain("Job Not Found");
		expect(r.content).toContain("`ghost`");
	});

	it("includes error section for failed jobs", () => {
		const job = fakeJob({ id: "fail-job", status: "errored" as AsyncJob["status"], errorText: "BAD" });
		const mgr = fakeManager([job]);
		const r = resolveJobs({ getAsyncJobManager: () => mgr }, "fail-job");
		expect(r.content).toContain("## Error");
		expect(r.content).toContain("BAD");
	});
});
