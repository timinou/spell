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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-session-manager-"));
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
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

async function makeEmacsTool(factory: () => Promise<EmacsSession>, config?: OrgConfig): Promise<OrgToolDefinition> {
	const { createOrgTool } = await import("../src/tool");
	return createOrgTool(tmpDir, config ?? makeConfig(), factory);
}

describe("createOrgTool session recovery", () => {
	test("retries after an Emacs startup failure instead of caching the rejected promise", async () => {
		let starts = 0;
		const session: EmacsSession = {
			socketPath: "/tmp/fake-org.sock",
			stop: async (): Promise<void> => {},
			isAlive: (): boolean => true,
		};
		const tool = await makeEmacsTool(async (): Promise<EmacsSession> => {
			starts += 1;
			if (starts === 1) {
				throw new Error("boom");
			}
			return session;
		});

		await expect(tool.execute({ command: "wave", file: "/tmp/plan.org" })).rejects.toThrow(
			"org: Emacs session unavailable",
		);
		await expect(tool.execute({ command: "wave", file: "/tmp/plan.org" })).resolves.toEqual({ success: true });
		expect(starts).toBe(2);
		expect(callToolMock).toHaveBeenCalledWith("org-next-wave", { file: "/tmp/plan.org" });
		await tool.dispose?.();
	});
});
