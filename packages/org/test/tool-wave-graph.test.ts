/**
 * Tests for cmdWave and cmdGraph wiring.
 *
 * Contracts:
 *   - wave delegates to org-next-wave elisp tool
 *   - graph delegates to org-dependency-graph elisp tool
 *   - file arg is forwarded directly
 *   - category arg resolves to absPath before forwarding
 *   - no args passes empty toolArgs
 */

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

describe("cmdWave", () => {
	test("calls org-next-wave with no args when none provided", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave" });
		expect(callToolMock).toHaveBeenCalledTimes(1);
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", {});
	});

	test("forwards file arg directly", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", file: "/some/path.org" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: "/some/path.org" });
	});

	test("resolves category to absPath", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", category: "plans" });
		const expectedPath = path.join(tmpDir, "tasks", "plans");
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: expectedPath });
	});

	test("file takes precedence over category", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", file: "/explicit.org", category: "plans" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: "/explicit.org" });
	});

	test("unknown category passes empty args", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "wave", category: "nonexistent" });
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", {});
	});
});

describe("cmdGraph", () => {
	test("calls org-dependency-graph with no args when none provided", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "graph" });
		expect(callToolMock).toHaveBeenCalledTimes(1);
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", {});
	});

	test("forwards file arg directly", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "graph", file: "/some/path.org" });
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", { file: "/some/path.org" });
	});

	test("resolves category to absPath", async () => {
		const tool = await makeEmacsTool();
		await tool.execute({ command: "graph", category: "features" });
		const expectedPath = path.join(tmpDir, "tasks", "features");
		expect(callToolMock).toHaveBeenCalledWith("org-dependency-graph", { file: expectedPath });
	});
});
