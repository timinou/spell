import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	type BufferInfo,
	type CodeEditOp,
	type CodeEditResult,
	type EmacsCodeClient,
	type EmacsSession,
	EmacsSessionManager,
	type EmacsWarmupResult,
	type InstallResult,
	type LanguageInfo,
	type OutlineEntry,
	type Resolution,
} from "@oh-my-pi/pi-emacs";
import * as clientModule from "@oh-my-pi/pi-emacs/client";

function makeSession(name: string, alive: boolean = true): EmacsSession {
	let currentAlive = alive;
	return {
		socketPath: `/tmp/${name}.sock`,
		isAlive: () => currentAlive,
		stop: async () => {
			currentAlive = false;
		},
	};
}

function ready(session: EmacsSession): EmacsWarmupResult {
	return {
		status: "ready",
		version: "30.2",
		session,
	};
}

function createClient(buffersResult: BufferInfo[]): EmacsCodeClient & { calls: { buffers: number; close: number } } {
	const calls = { buffers: 0, close: 0 };
	return {
		calls,
		async read(_file: string, _resolution?: Resolution, _offset?: number, _limit?: number): Promise<string> {
			throw new Error("not implemented in test");
		},
		async outline(_file: string, _depth?: number): Promise<OutlineEntry[]> {
			throw new Error("not implemented in test");
		},
		async edit(_op: CodeEditOp): Promise<CodeEditResult> {
			throw new Error("not implemented in test");
		},
		async buffers(): Promise<BufferInfo[]> {
			calls.buffers += 1;
			return buffersResult;
		},
		async bufferDiff(_file: string): Promise<string> {
			throw new Error("not implemented in test");
		},
		async navigate(_file: string, _action: string, _line?: number, _column?: number): Promise<unknown> {
			throw new Error("not implemented in test");
		},
		async languages(_installedOnly?: boolean): Promise<LanguageInfo[]> {
			throw new Error("not implemented in test");
		},
		async installGrammar(
			_lang: string,
			_url?: string,
			_revision?: string,
			_sourceDir?: string,
		): Promise<InstallResult> {
			throw new Error("not implemented in test");
		},
		async callTool(_name: string, _args: Record<string, unknown>): Promise<unknown> {
			throw new Error("not implemented in test");
		},
		async close(): Promise<void> {
			calls.close += 1;
		},
	};
}

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("coding-agent emacs tool wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the session manager to recover from a dead cached daemon", async () => {
		const replacement = makeSession("replacement");
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				return ready(replacement);
			},
		});
		manager.setSession(makeSession("dead", false));

		const buffersResult: BufferInfo[] = [
			{
				file: "src/recovered.ts",
				modified: false,
				size: 64,
				language: "typescript",
				lastAccessed: 1700000000000,
			},
		];
		const client = createClient(buffersResult);
		const createClientSpy = spyOn(clientModule, "createEmacsClient").mockResolvedValue(client);
		const tools = await createTools(createSession({ emacsSessionManager: manager }), ["emacs_code"]);
		const tool = tools.find(entry => entry.name === "emacs_code");
		if (!tool) throw new Error("Missing emacs_code tool");

		const result = await tool.execute("emacs-recovery", { command: "buffers" });
		const text = result.content.find(content => content.type === "text")?.text ?? "{}";

		expect(JSON.parse(text)).toEqual(buffersResult);
		expect(starts).toBe(1);
		expect(createClientSpy).toHaveBeenCalledTimes(1);
		expect(client.calls.buffers).toBe(1);
		expect(client.calls.close).toBe(1);
	});
});
