import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EmacsSession } from "../src/emacs/daemon";
import type { OrgConfig } from "../src/types";
import type { OrgToolDefinition } from "../src/tool";

const callToolMock = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ success: true }));
const createOrgClientMock = vi.fn(async () => ({
	callTool: callToolMock,
	close: async (): Promise<void> => {},
}));

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-section-output-"));
	callToolMock.mockReset();
	createOrgClientMock.mockClear();
	mock.module("../src/emacs/client", () => ({
		createOrgClient: createOrgClientMock,
	}));
});

afterEach(async () => {
	mock.restore();
	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(): OrgConfig {
	return {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					plans: { prefix: "PLAN", path: "plans" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

async function makeEmacsTool(config?: OrgConfig): Promise<OrgToolDefinition> {
	const session: EmacsSession = {
		socketPath: "/tmp/fake-org.sock",
		stop: async (): Promise<void> => {},
		isAlive: (): boolean => true,
	};
	const { createOrgTool } = await import("../src/tool");
	return createOrgTool(tmpDir, config ?? makeConfig(), async (): Promise<EmacsSession> => session);
}

async function seedPlanFile(id: string): Promise<string> {
	const dir = path.join(tmpDir, "tasks", "plans");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.org`);
	await Bun.write(
		filePath,
		`#+TITLE: Sectioned plan
#+STATE: ITEM
#+CUSTOM_ID: ${id}

* Context
Old context.

* Verification
- Existing check
`,
	);
	return filePath;
}

function getRequiredString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") {
		throw new Error(`Expected ${key} to be a string`);
	}
	return value;
}

describe("createOrgTool section update output", () => {
	test("successful section replace returns the whole updated file content", async () => {
		const id = "PLAN-008-org-section-level-editing";
		const filePath = await seedPlanFile(id);
		const tool = await makeEmacsTool();

		callToolMock.mockImplementationOnce(async (name: string, args: Record<string, unknown>) => {
			expect(name).toBe("org-edit-section");
			const targetFile = getRequiredString(args, "file");
			const body = getRequiredString(args, "body");
			const content = await Bun.file(targetFile).text();
			await Bun.write(targetFile, content.replace("Old context.", body));
			return { success: true };
		});

		const result = (await tool.execute({
			command: "update",
			id,
			file: filePath,
			section: "Context",
			body: "Revised context.",
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
		expect(result.section).toBe("Context");
		expect(result.updated).toEqual(["body"]);
		expect(result.fileContent).toBe(
			`#+TITLE: Sectioned plan
#+STATE: ITEM
#+CUSTOM_ID: ${id}

* Context
Revised context.

* Verification
- Existing check
`,
		);
	});
});
