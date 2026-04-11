import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspModule from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EmacsSession, EmacsSessionManager } from "@oh-my-pi/pi-emacs";

interface MockOrgToolInstance {
	projectRoot: string;
	dispose: ReturnType<typeof vi.fn>;
	execute: ReturnType<typeof vi.fn>;
}

function makeEmacsSession(socketPath: string): EmacsSession {
	return {
		socketPath,
		stop: async (): Promise<void> => {},
		isAlive: (): boolean => true,
	};
}

function makeSessionManager(socketPath: string): EmacsSessionManager {
	return {
		getSession: vi.fn(async () => makeEmacsSession(socketPath)),
		dispose: async (): Promise<void> => {},
	} as unknown as EmacsSessionManager;
}

function createSession(cwdState: { current: string }, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		get cwd() {
			return cwdState.current;
		},
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "org.enabled": true }),
		...overrides,
	};
}

describe("tool cwd changes after move", () => {
	let tempDir = "";
	let firstProject = "";
	let secondProject = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "org-cwd-change-"));
		firstProject = path.join(tempDir, "project-a");
		secondProject = path.join(tempDir, "project-b");
		await fs.mkdir(firstProject, { recursive: true });
		await fs.mkdir(secondProject, { recursive: true });
	});

	afterEach(async () => {
		mock.restore();
		vi.restoreAllMocks();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("recreates the inner org tool when the session cwd changes", async () => {
		const instances: MockOrgToolInstance[] = [];
		const createOrgToolMock = vi.fn((projectRoot: string) => {
			const instance: MockOrgToolInstance = {
				projectRoot,
				dispose: vi.fn(async (): Promise<void> => {}),
				execute: vi.fn(async (): Promise<Record<string, unknown>> => ({ success: true, projectRoot })),
			};
			instances.push(instance);
			return {
				name: "org",
				description: "mock org tool",
				parameters: {},
				execute: instance.execute,
				dispose: instance.dispose,
			};
		});
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
		const orgSessionManager = makeSessionManager("/tmp/org.sock");
		const cwdState = { current: firstProject };
		const tool = new OrgTool(
			createSession(cwdState, {
				getSessionId: () => "session-a",
				orgSessionManager,
			}),
		);

		await tool.execute("call-1", { command: "query", query: "todo:ITEM" });
		cwdState.current = secondProject;
		await tool.execute("call-2", { command: "query", query: "todo:ITEM" });

		expect(createOrgToolMock).toHaveBeenCalledTimes(2);
		expect(instances).toHaveLength(2);
		expect(instances[0]?.projectRoot).toBe(firstProject);
		expect(instances[1]?.projectRoot).toBe(secondProject);
		expect(instances[0]?.dispose).toHaveBeenCalledTimes(1);
		expect(instances[1]?.dispose).not.toHaveBeenCalled();

		const firstCall = createOrgToolMock.mock.calls[0] as unknown[] | undefined;
		const secondCall = createOrgToolMock.mock.calls[1] as unknown[] | undefined;
		const firstOptions = (firstCall?.[2] ?? null) as {
			emacsSessionManager?: EmacsSessionManager;
			ownsSessionManager?: boolean;
		} | null;
		const secondOptions = (secondCall?.[2] ?? null) as {
			emacsSessionManager?: EmacsSessionManager;
			ownsSessionManager?: boolean;
		} | null;
		expect(firstOptions).not.toBeNull();
		expect(secondOptions).not.toBeNull();
		if (!firstOptions || !secondOptions) throw new Error("Expected org tool options");
		expect(firstOptions.emacsSessionManager).toBe(orgSessionManager);
		expect(secondOptions.emacsSessionManager).toBe(orgSessionManager);
		expect(firstOptions.ownsSessionManager).toBe(false);
		expect(secondOptions.ownsSessionManager).toBe(false);

		await tool.dispose();
		expect(instances[1]?.dispose).toHaveBeenCalledTimes(1);
	});

	it("resolves send_file paths against the current session cwd", async () => {
		const { SendFileTool } = await import("@oh-my-pi/pi-coding-agent/tools/send-file");
		const cwdState = { current: firstProject };
		const tool = new SendFileTool(createSession(cwdState));
		const movedFile = path.join(secondProject, "report.txt");
		await Bun.write(movedFile, "moved");

		cwdState.current = secondProject;
		const result = await tool.execute("call-send", { path: "report.txt" });

		expect(result.details?.delivery.absolutePath).toBe(movedFile);
		expect(result.details?.delivery.fileName).toBe("report.txt");
	});

	it("recreates the write-tool LSP writethrough when the session cwd changes", async () => {
		const writethroughCalls: Array<{ cwd: string; dst: string }> = [];
		const createLspWritethroughSpy = vi
			.spyOn(lspModule, "createLspWritethrough")
			.mockImplementation((cwd: string) => async dst => {
				writethroughCalls.push({ cwd, dst });
				return undefined;
			});
		const { WriteTool } = await import("@oh-my-pi/pi-coding-agent/tools/write");
		const cwdState = { current: firstProject };
		const tool = new WriteTool(
			createSession(cwdState, {
				enableLsp: true,
				settings: Settings.isolated({
					"lsp.formatOnWrite": true,
					"lsp.diagnosticsOnWrite": true,
				}),
			}),
		);

		await tool.execute("call-write-1", { path: "draft.txt", content: "first\n" });
		cwdState.current = secondProject;
		await tool.execute("call-write-2", { path: "draft.txt", content: "second\n" });

		expect(createLspWritethroughSpy).toHaveBeenCalledTimes(2);
		expect(createLspWritethroughSpy.mock.calls[0]?.[0]).toBe(firstProject);
		expect(createLspWritethroughSpy.mock.calls[1]?.[0]).toBe(secondProject);
		expect(writethroughCalls).toEqual([
			{ cwd: firstProject, dst: path.join(firstProject, "draft.txt") },
			{ cwd: secondProject, dst: path.join(secondProject, "draft.txt") },
		]);
	});
});
