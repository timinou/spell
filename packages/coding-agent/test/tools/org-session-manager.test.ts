import { afterEach, beforeEach, describe, expect, mock, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as orgPlanModule from "@oh-my-pi/pi-coding-agent/plan-mode/org-plan";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ExitPlanModeTool } from "@oh-my-pi/pi-coding-agent/tools/exit-plan-mode";
import type { EmacsSession, EmacsSessionManager } from "@oh-my-pi/pi-emacs";
import * as orgModule from "@oh-my-pi/pi-org";

let tmpDir: string;
let artifactsDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-org-session-manager-"));
	artifactsDir = path.join(tmpDir, "artifacts");
	await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
	await Bun.write(path.join(artifactsDir, "local", "PLAN.md"), "# Plan\n");
});

afterEach(async () => {
	mock.restore();
	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEmacsSession(socketPath: string): EmacsSession {
	return {
		socketPath,
		stop: async (): Promise<void> => {},
		isAlive: (): boolean => true,
	};
}

function makeSessionManager(socketPath: string): {
	manager: EmacsSessionManager;
	getSession: ReturnType<typeof vi.fn>;
} {
	const getSession = vi.fn(async () => makeEmacsSession(socketPath));
	return {
		manager: {
			getSession,
			dispose: async (): Promise<void> => {},
		} as unknown as EmacsSessionManager,
		getSession,
	};
}

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "org.enabled": true }),
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "session-a",
		getPlanModeState: () => ({ type: "plan" as const, enabled: true, planFilePath: "local://PLAN.md" }),
		...overrides,
	};
}

describe("org session manager wiring", () => {
	test("OrgTool prefers the dedicated org session manager over the code daemon manager", async () => {
		const createOrgToolMock = vi.fn(() => ({
			name: "org",
			description: "mock org tool",
			parameters: {},
			execute: async (): Promise<Record<string, unknown>> => ({ success: true }),
			dispose: async (): Promise<void> => {},
		}));
		mock.module("@oh-my-pi/pi-org", () => ({
			DEFAULT_ORG_CONFIG: {
				dirs: { tasks: { path: "tasks", categories: {} } },
				todoKeywords: ["ITEM"],
				requiredProperties: ["CUSTOM_ID"],
			},
			createOrgTool: createOrgToolMock,
			detectEmacs: vi.fn(async () => ({
				found: true,
				meetsMinimum: true,
				socatFound: true,
				errors: [],
				path: "/usr/bin/emacs",
				version: "30.2",
			})),
		}));

		const { OrgTool } = await import("@oh-my-pi/pi-coding-agent/tools/org");
		const codeManager = makeSessionManager("/tmp/code.sock");
		const orgManager = makeSessionManager("/tmp/org.sock");
		const tool = new OrgTool(
			createSession({
				emacsSessionManager: codeManager.manager,
				orgSessionManager: orgManager.manager,
			}),
		);

		expect(createOrgToolMock).toHaveBeenCalledTimes(1);
		const firstCall = createOrgToolMock.mock.calls[0] as unknown as unknown[] | undefined;
		expect(firstCall).toBeDefined();
		const options = ((firstCall ? firstCall[2] : null) ?? null) as unknown as {
			emacsSessionManager?: EmacsSessionManager;
			ownsSessionManager?: boolean;
		};
		expect(options.emacsSessionManager).toBe(orgManager.manager);
		expect(options.ownsSessionManager).toBe(false);
		await tool.dispose();
	});

	test("ExitPlanModeTool auto-initializes from plan waves without opening an org MCP session", async () => {
		const resolvePlanItemSpy = spyOn(orgPlanModule, "resolvePlanItem").mockImplementation(
			async (_settings, _projectRoot, itemId) => {
				if (itemId === "PLAN-001-auth-initiative") {
					return {
						id: itemId,
						file: path.join(tmpDir, "!tasks", "plans", `${itemId}.org`),
						body: "* Context\nAuth rollout\n\n* Execution Manifest\n** foundation :wave:\n- [[id:FEAT-001-auth-api]] Implement auth API",
					};
				}
				if (itemId === "FEAT-001-auth-api") {
					return {
						id: itemId,
						file: path.join(tmpDir, "!tasks", "features", `${itemId}.org`),
						body: "* Scope\nImplement auth API",
					};
				}
				return null;
			},
		);

		const codeManager = makeSessionManager("/tmp/code.sock");
		const orgManager = makeSessionManager("/tmp/org.sock");
		const createOrgClientSpy = spyOn(orgModule, "createOrgClient");
		const tool = new ExitPlanModeTool(
			createSession({
				emacsSessionManager: codeManager.manager,
				orgSessionManager: orgManager.manager,
			}),
		);

		const result = await tool.execute("call-org", {
			title: "AUTH_INITIATIVE",
			itemId: "PLAN-001-auth-initiative",
		});

		expect(resolvePlanItemSpy).toHaveBeenCalled();
		expect(codeManager.getSession).not.toHaveBeenCalled();
		expect(orgManager.getSession).not.toHaveBeenCalled();
		expect(createOrgClientSpy).not.toHaveBeenCalled();
		expect(result.details?.waves).toEqual([
			{
				name: "foundation",
				entries: [{ id: "FEAT-001-auth-api", orgItemId: "FEAT-001-auth-api", step: "Implement auth API" }],
			},
		]);
	});
});
