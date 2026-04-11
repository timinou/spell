import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SendFileTool } from "@oh-my-pi/pi-coding-agent/tools/send-file";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

function createToolSession(
	sessionManager: SessionManager,
	settings: Settings,
	overrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		get cwd() {
			return sessionManager.getCwd();
		},
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

describe("tool cwd refresh after SessionManager.moveTo", () => {
	let tempDir = "";
	let firstProject = "";
	let secondProject = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-cwd-move-"));
		setAgentDir(tempDir);
		firstProject = path.join(tempDir, "project-a");
		secondProject = path.join(tempDir, "project-b");
		await fs.mkdir(firstProject, { recursive: true });
		await fs.mkdir(secondProject, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves send_file paths against the moved session cwd", async () => {
		const sessionManager = SessionManager.create(firstProject);
		const tool = new SendFileTool(createToolSession(sessionManager, Settings.isolated()));
		const originalFile = path.join(firstProject, "report.txt");
		const movedFile = path.join(secondProject, "report.txt");
		await Bun.write(originalFile, "from-a");
		await Bun.write(movedFile, "from-b");

		await sessionManager.moveTo(secondProject);
		const result = await tool.execute("call-send", { path: "report.txt" });

		expect(sessionManager.getCwd()).toBe(path.resolve(secondProject));
		expect(result.details?.delivery.absolutePath).toBe(movedFile);
		expect(result.details?.delivery.fileName).toBe("report.txt");
	});

	it("writes relative paths into the moved session cwd", async () => {
		const sessionManager = SessionManager.create(firstProject);
		const tool = new WriteTool(createToolSession(sessionManager, Settings.isolated(), { enableLsp: false }));
		const originalFile = path.join(firstProject, "draft.txt");
		const movedFile = path.join(secondProject, "draft.txt");

		await tool.execute("call-write-1", { path: "draft.txt", content: "first\n" });
		expect(await Bun.file(originalFile).text()).toBe("first\n");

		await sessionManager.moveTo(secondProject);
		await tool.execute("call-write-2", { path: "draft.txt", content: "second\n" });

		expect(sessionManager.getCwd()).toBe(path.resolve(secondProject));
		expect(await Bun.file(originalFile).text()).toBe("first\n");
		expect(await Bun.file(movedFile).text()).toBe("second\n");
	});
});
