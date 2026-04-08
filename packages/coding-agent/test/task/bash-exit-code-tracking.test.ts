import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { CursorExecHandlers } from "../../src/cursor";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";

let artifactCounter = 0;

function createTestToolSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	};
}

describe("bash exit code tracking", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-exit-tracking-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("preserves successful bash cwd and exit code in cursor bridge results", async () => {
		const session = createTestToolSession(testDir);
		const bashTool = wrapToolWithMetaNotice(new BashTool(session));
		const handlers = new CursorExecHandlers({ cwd: testDir, tools: new Map([["bash", bashTool as never]]) as never });

		const result = await handlers.shell({
			command: "echo ok",
			toolCallId: "call-1",
			workingDirectory: testDir,
		} as never);
		const details = (result.details ?? {}) as { exitCode?: number; cwd?: string };

		expect(result.isError).toBe(false);
		expect(result.content.find(item => item.type === "text")?.text).toContain("ok");
		expect(details.exitCode).toBe(0);
		expect(details.cwd).toBe(testDir);
	});

	it("preserves failing bash cwd and real exit code in cursor bridge results", async () => {
		const session = createTestToolSession(testDir);
		const bashTool = wrapToolWithMetaNotice(new BashTool(session));
		const handlers = new CursorExecHandlers({ cwd: testDir, tools: new Map([["bash", bashTool as never]]) as never });

		const result = await handlers.shell({
			command: "exit 7",
			toolCallId: "call-2",
			workingDirectory: testDir,
		} as never);
		const details = (result.details ?? {}) as { exitCode?: number; cwd?: string };
		const text = result.content.find(item => item.type === "text")?.text ?? "";

		expect(result.isError).toBe(true);
		expect(text).toContain("Command exited with code 7");
		expect(details.exitCode).toBe(7);
		expect(details.cwd).toBe(testDir);
	});
});
