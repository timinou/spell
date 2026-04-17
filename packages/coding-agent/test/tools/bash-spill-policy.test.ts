import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

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
		allocateOutputArtifact: async (toolType: string, extension?: string) => {
			const id = String(artifactCounter++);
			const ext = extension ?? "txt";
			const artifactDir = path.join(sessionDir, "main", toolType);
			fs.mkdirSync(artifactDir, { recursive: true });
			const artifactPath = path.join(artifactDir, `${id}.${ext}`);
			return { id, uri: `artifact://test-session/main/${toolType}/${id}.${ext}`, path: artifactPath };
		},
		settings,
	};
}

describe("bash spill policy", () => {
	let testDir: string;
	let bashTool: BashTool;

	beforeEach(() => {
		artifactCounter = 0;
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-spill-policy-"));
		bashTool = wrapToolWithMetaNotice(new BashTool(createTestToolSession(testDir)));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("spills successful bash output once it crosses the low line threshold", async () => {
		const result = await bashTool.execute(
			"call-1",
			{ command: "i=1; while [ $i -le 80 ]; do echo line$i; i=$((i+1)); done" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain("line80");
		expect(text).toContain("line32");
		expect(text).not.toContain("line31\n");
		expect(text).toContain("artifact://test-session/main/bash/0.txt");
	});

	it("lenientSpill widens only the current bash call and emits a warning", async () => {
		const lenient = await bashTool.execute(
			"call-2",
			{ command: "i=1; while [ $i -le 80 ]; do echo line$i; i=$((i+1)); done", lenientSpill: true },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const lenientText = lenient.content.find(block => block.type === "text")?.text ?? "";
		expect(lenientText).toContain("lenientSpill enabled");
		expect(lenientText).toContain("line1");
		expect(lenientText).toContain("line80");
		expect(lenientText).not.toContain("artifact://");

		const strictAgain = await bashTool.execute(
			"call-3",
			{ command: "i=1; while [ $i -le 80 ]; do echo line$i; i=$((i+1)); done" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const strictText = strictAgain.content.find(block => block.type === "text")?.text ?? "";
		expect(strictText).toContain("artifact://test-session/main/bash/1.txt");
		expect(strictText).not.toContain("line31\n");
	});

	it("keeps a larger inline residue on failing bash calls", async () => {
		try {
			await bashTool.execute(
				"call-4",
				{ command: "i=1; while [ $i -le 140 ]; do echo line$i; i=$((i+1)); done; exit 7" },
				undefined,
				undefined,
				{ hasUI: false } as never,
			);
			throw new Error("expected bash tool to fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("artifact://test-session/main/bash/0.txt");
			expect(message).toContain("line22");
			expect(message).toContain("line140");
			expect(message).not.toContain("line21\n");
			expect(message).toContain("Command exited with code 7");
		}
	});
});
