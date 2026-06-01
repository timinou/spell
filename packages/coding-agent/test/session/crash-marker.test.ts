import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@spell/pi-utils";
import { SessionManager } from "../../src/session/session-manager";

describe("appendCrashMarker", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			await dir.remove();
		}
		tempDirs.length = 0;
	});

	it("writes crash entry to session JSONL", async () => {
		const tempDir = TempDir.createSync("@pi-crash-marker-");
		tempDirs.push(tempDir);

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		// Append a user message so the session file has content
		sessionManager.appendMessage({
			role: "user",
			content: "Hello",
			timestamp: Date.now(),
		});

		// Append an assistant message (required for persistence to begin)
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Hi" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Append crash marker
		sessionManager.appendCrashMarker("sighup");

		// Flush to disk
		await sessionManager.flush();

		// Read the session file and verify the last entry
		const sessionFile = sessionManager.getSessionFile()!;
		expect(sessionFile).toBeDefined();

		const content = await fs.readFile(sessionFile, "utf8");
		const lines = content.trim().split("\n");

		// Last line should be the crash marker
		const lastEntry = JSON.parse(lines[lines.length - 1]);
		expect(lastEntry.type).toBe("crash");
		expect(lastEntry.reason).toBe("sighup");
		expect(lastEntry.id).toBeDefined();
		expect(lastEntry.parentId).toBeDefined();
		expect(lastEntry.timestamp).toBeDefined();
	});

	it("is a no-op on an in-memory session (no persistence)", () => {
		const sessionManager = SessionManager.inMemory();

		// Should not throw
		expect(() => sessionManager.appendCrashMarker("sigterm")).not.toThrow();
	});
});
