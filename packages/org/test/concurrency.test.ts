import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendItemToFile, applyItemMutations } from "../src/org-writer";
import { createOrgTool, type OrgToolDefinition } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-concurrency-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readFile(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

function makeConfig(overrides?: Partial<OrgConfig>): OrgConfig {
	const base: OrgConfig = {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					drafts: { prefix: "DRAFT", path: "drafts" },
					projects: { prefix: "PROJ", path: "projects" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
	return { ...base, ...overrides };
}

function makeTool(config?: OrgConfig): OrgToolDefinition {
	const stubEmacs = (): Promise<never> => Promise.reject(new Error("Emacs not used in concurrency tests"));
	return createOrgTool(tmpDir, config ?? makeConfig(), stubEmacs);
}

function sequenceNumber(id: string): number {
	const match = /^[A-Z]+-(\d+)(?:-|$)/.exec(id);
	if (!match) {
		throw new Error(`ID does not contain sequence: ${id}`);
	}
	return Number.parseInt(match[1], 10);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms);
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("org concurrency contracts", () => {
	test("concurrent appendItemToFile calls to the same file preserve both items", async () => {
		const filePath = path.join(tmpDir, "shared.org");
		await Bun.write(filePath, "#+TITLE: Shared\n#+STATE: ITEM\n#+CUSTOM_ID: ROOT-001\n\n");

		await Promise.all([
			appendItemToFile(
				filePath,
				{ title: "First", category: "drafts", state: "ITEM", id: "DRAFT-010-first" },
				"ITEM",
			),
			appendItemToFile(
				filePath,
				{ title: "Second", category: "drafts", state: "ITEM", id: "DRAFT-011-second" },
				"ITEM",
			),
		]);

		const content = await readFile(filePath);
		expect(content).toContain(":CUSTOM_ID: DRAFT-010-first");
		expect(content).toContain(":CUSTOM_ID: DRAFT-011-second");
	});

	test("concurrent applyItemMutations calls against different items in the same file both apply", async () => {
		const filePath = path.join(tmpDir, "mutate-shared.org");
		await Bun.write(
			filePath,
			`* ITEM Item A
:PROPERTIES:
:CUSTOM_ID: DRAFT-100-a
:END:

* ITEM Item B
:PROPERTIES:
:CUSTOM_ID: DRAFT-101-b
:END:
`,
		);

		const [a, b] = await Promise.all([
			applyItemMutations(filePath, "DRAFT-100-a", { state: "DOING" }, TODO_KEYWORDS),
			applyItemMutations(filePath, "DRAFT-101-b", { state: "REVIEW" }, TODO_KEYWORDS),
		]);

		expect(a).toEqual(["state"]);
		expect(b).toEqual(["state"]);

		const content = await readFile(filePath);
		expect(content).toContain("* DOING Item A");
		expect(content).toContain("* REVIEW Item B");
	});

	test("applyItemMutations returning null does not block a subsequent valid mutation", async () => {
		const filePath = path.join(tmpDir, "null-then-valid.org");
		await Bun.write(
			filePath,
			`* ITEM Existing
:PROPERTIES:
:CUSTOM_ID: DRAFT-200-existing
:END:
`,
		);

		const miss = await applyItemMutations(filePath, "DRAFT-999-missing", { state: "DONE" }, TODO_KEYWORDS);
		expect(miss).toBeNull();

		const hit = await applyItemMutations(filePath, "DRAFT-200-existing", { state: "DOING" }, TODO_KEYWORDS);
		expect(hit).toEqual(["state"]);

		const content = await readFile(filePath);
		expect(content).toContain("* DOING Existing");
	});

	test("a failing appendItemToFile call does not permanently block a later valid write", async () => {
		const filePath = path.join(tmpDir, "same-path.org");
		await fs.mkdir(filePath, { recursive: true });

		await expect(
			appendItemToFile(
				filePath,
				{ title: "Will fail", category: "drafts", state: "ITEM", id: "DRAFT-300-fail" },
				"ITEM",
			),
		).rejects.toBeDefined();

		await fs.rm(filePath, { recursive: true, force: true });
		await appendItemToFile(
			filePath,
			{ title: "Will succeed", category: "drafts", state: "ITEM", id: "DRAFT-301-success" },
			"ITEM",
		);

		const content = await readFile(filePath);
		expect(content).toContain("#+CUSTOM_ID: DRAFT-301-success");
	});

	test("concurrent create commands in the same category produce distinct sequence numbers", async () => {
		const tool = makeTool();
		const draftsDir = path.join(tmpDir, "tasks", "drafts");
		await fs.mkdir(draftsDir, { recursive: true });
		await Bun.write(path.join(draftsDir, "seed.org"), "#+TITLE: Seed\n#+STATE: ITEM\n#+CUSTOM_ID: DRAFT-001-seed\n");

		const [r1, r2] = await Promise.all([
			tool.execute({ command: "create", category: "drafts", title: "One" }) as Promise<Record<string, unknown>>,
			tool.execute({ command: "create", category: "drafts", title: "Two" }) as Promise<Record<string, unknown>>,
		]);

		expect(r1.success).toBe(true);
		expect(r2.success).toBe(true);

		const id1 = String(r1.id);
		const id2 = String(r2.id);
		const n1 = sequenceNumber(id1);
		const n2 = sequenceNumber(id2);
		expect(new Set([n1, n2])).toEqual(new Set([2, 3]));
	});

	test("concurrent creates in different categories do not serialize behind one another", async () => {
		const config = makeConfig({
			dirs: {
				tasks: {
					path: "tasks",
					categories: {
						a: { prefix: "A", path: "a" },
						b: { prefix: "B", path: "b" },
					},
				},
			},
		});
		const tool = makeTool(config);

		const catADir = path.join(tmpDir, "tasks", "a");
		const catBDir = path.join(tmpDir, "tasks", "b");
		await fs.mkdir(catADir, { recursive: true });
		await fs.mkdir(catBDir, { recursive: true });

		const fifoPath = path.join(catADir, "blocker.org");
		const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
		expect(mkfifo.exitCode).toBe(0);

		const createA = tool.execute({ command: "create", category: "a", title: "Category A item" }) as Promise<
			Record<string, unknown>
		>;
		await Bun.sleep(30);

		const createB = withTimeout(
			tool.execute({ command: "create", category: "b", title: "Category B item" }) as Promise<
				Record<string, unknown>
			>,
			1000,
			"category B create while category A is blocked",
		);

		const bResult = await createB;
		expect(bResult.success).toBe(true);

		await Bun.write(fifoPath, ":CUSTOM_ID: A-001-seed\n");
		const aResult = await withTimeout(createA, 1000, "category A create after unblock");
		expect(aResult.success).toBe(true);
	});

	test("concurrent create plus update to the same file complete without deadlock", async () => {
		const tool = makeTool();
		const draftsDir = path.join(tmpDir, "tasks", "drafts");
		await fs.mkdir(draftsDir, { recursive: true });

		const filePath = path.join(draftsDir, "shared.org");
		await Bun.write(
			filePath,
			`* ITEM Existing
:PROPERTIES:
:CUSTOM_ID: DRAFT-001-existing
:END:
`,
		);

		const createPromise = tool.execute({
			command: "create",
			category: "drafts",
			title: "Created concurrently",
			file: "shared",
		}) as Promise<Record<string, unknown>>;

		const updatePromise = tool.execute({
			command: "update",
			id: "DRAFT-001-existing",
			state: "DOING",
			file: filePath,
		}) as Promise<Record<string, unknown>>;

		const [createResult, updateResult] = await withTimeout(
			Promise.all([createPromise, updatePromise]),
			1500,
			"concurrent create/update on same file",
		);

		expect(createResult.success).toBe(true);
		expect(updateResult.success).toBe(true);

		const content = await readFile(filePath);
		expect(content).toContain("* DOING Existing");
		expect(content).toContain(String(createResult.id));
	});
});
