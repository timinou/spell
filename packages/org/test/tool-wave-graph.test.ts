import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EmacsSession } from "@oh-my-pi/pi-emacs";
import type { OrgToolDefinition } from "../src/tool";
import type { OrgConfig } from "../src/types";

const callToolMock = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ success: true }));
const createOrgClientMock = vi.fn(async () => ({
	callTool: callToolMock,
	close: async (): Promise<void> => {},
}));

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-wave-graph-"));
	callToolMock.mockReset();
	callToolMock.mockResolvedValue({ success: true });
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
					features: { prefix: "FEAT", path: "features" },
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

async function writeCategoryFile(category: "plans" | "features", fileName: string): Promise<string> {
	const dir = path.join(tmpDir, "tasks", category);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, fileName);
	await Bun.write(filePath, "#+TITLE: test\n#+CUSTOM_ID: ITEM-001\n* ITEM Example\n");
	return filePath;
}

describe("cmdWave", () => {
	test("calls org-next-wave with all category files when no args are provided", async () => {
		const plansA = await writeCategoryFile("plans", "plan-a.org");
		const plansB = await writeCategoryFile("plans", "plan-b.org");
		const featureA = await writeCategoryFile("features", "feature-a.org");
		const tool = await makeEmacsTool();

		await tool.execute({ command: "wave" });
		expect(callToolMock).toHaveBeenCalledTimes(1);
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", {
			files: [featureA, plansA, plansB].sort(),
		});
	});

	test("forwards file arg directly", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", file: "/some/path.org" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: "/some/path.org" });
	});

	test("resolves category to its org files", async () => {
		const plansA = await writeCategoryFile("plans", "plan-a.org");
		const plansB = await writeCategoryFile("plans", "plan-b.org");
		const tool = await makeEmacsTool();

		await tool.execute({ command: "wave", category: "plans" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { files: [plansA, plansB].sort() });
	});

	test("accepts category prefixes", async () => {
		const featureA = await writeCategoryFile("features", "feature-a.org");
		const tool = await makeEmacsTool();

		await tool.execute({ command: "wave", category: "FEAT" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { files: [featureA] });
	});

	test("file takes precedence over category", async () => {
		await writeCategoryFile("plans", "plan-a.org");
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", file: "/explicit.org", category: "plans" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: "/explicit.org" });
	});

	test("unknown category returns a tool error instead of falling through", async () => {
		const tool = await makeEmacsTool();
		expect(await tool.execute({ command: "wave", category: "nonexistent" })).toEqual({
			error: true,
			message: "Category not found: nonexistent",
		});
		expect(callToolMock).not.toHaveBeenCalled();
	});
});

describe("cmdGraph", () => {
	test("calls org-dependency-graph with all category files when no args are provided", async () => {
		const plansA = await writeCategoryFile("plans", "plan-a.org");
		const featureA = await writeCategoryFile("features", "feature-a.org");
		const tool = await makeEmacsTool();

		await tool.execute({ command: "graph" });
		expect(callToolMock).toHaveBeenCalledTimes(1);
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", {
			files: [featureA, plansA].sort(),
		});
	});

	test("forwards file arg directly", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "graph", file: "/some/path.org" });
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", { file: "/some/path.org" });
	});

	test("resolves category to its org files", async () => {
		const featureA = await writeCategoryFile("features", "feature-a.org");
		const featureB = await writeCategoryFile("features", "feature-b.org");
		const tool = await makeEmacsTool();

		await tool.execute({ command: "graph", category: "features" });
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", { files: [featureA, featureB].sort() });
	});
});
