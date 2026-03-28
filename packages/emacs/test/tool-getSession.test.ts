import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as clientModule from "../src/client";
import type { EmacsSession } from "../src/daemon";
import { createEmacsTool } from "../src/tool";
import type { BufferInfo, CodeEditOp, CodeEditResult, EmacsCodeClient, OutlineEntry, Resolution } from "../src/types";

function makeSession(isAlive: boolean): EmacsSession {
	return {
		socketPath: "/tmp/spell-emacs-test.sock",
		isAlive: () => isAlive,
		stop: async () => {},
	};
}

function createClient(options?: {
	buffersResult?: BufferInfo[];
}): EmacsCodeClient & { calls: { buffers: number; close: number } } {
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
			return options?.buffersResult ?? [];
		},
		async bufferDiff(_file: string): Promise<string> {
			throw new Error("not implemented in test");
		},
		async navigate(_file: string, _action: string, _line?: number, _column?: number): Promise<unknown> {
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

describe("createEmacsTool getSession behavior", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns daemon unavailable when getSession resolves null", async () => {
		const createClientSpy = spyOn(clientModule, "createEmacsClient");
		const tool = createEmacsTool("/tmp/project", {
			getSession: async () => null,
		});

		const result = await tool.execute({ command: "buffers" });

		expect(result).toEqual({ error: true, message: "Emacs daemon unavailable" });
		expect(createClientSpy).not.toHaveBeenCalled();
	});

	it("returns daemon unavailable when getSession resolves a dead session", async () => {
		const createClientSpy = spyOn(clientModule, "createEmacsClient");
		const tool = createEmacsTool("/tmp/project", {
			getSession: async () => makeSession(false),
		});

		const result = await tool.execute({ command: "buffers" });

		expect(result).toEqual({ error: true, message: "Emacs daemon unavailable" });
		expect(createClientSpy).not.toHaveBeenCalled();
	});

	it("uses the client when getSession resolves a live session", async () => {
		const buffersResult: BufferInfo[] = [
			{
				file: "src/index.ts",
				modified: false,
				size: 123,
				language: "typescript",
				lastAccessed: 1700000000000,
			},
		];
		const client = createClient({ buffersResult });
		const createClientSpy = spyOn(clientModule, "createEmacsClient").mockResolvedValue(client);
		const tool = createEmacsTool("/tmp/project", {
			getSession: async () => makeSession(true),
		});

		const result = await tool.execute({ command: "buffers" });

		expect(result).toEqual(buffersResult);
		expect(createClientSpy).toHaveBeenCalledTimes(1);
		expect(client.calls.buffers).toBe(1);
		expect(client.calls.close).toBe(1);
	});
});
