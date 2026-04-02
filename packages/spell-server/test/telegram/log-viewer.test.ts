import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatSession } from "../../src/rpc/bridge-types";
import { type SessionProvider, startLogViewer } from "../../src/telegram/log-viewer/server";
import type { TelegramBridgeConfig } from "../../src/telegram/types";

class MockSessionProvider implements SessionProvider {
	#sessions: ChatSession[];
	#paths: Map<string, string>;

	constructor(sessions: ChatSession[], paths: Map<string, string>) {
		this.#sessions = sessions;
		this.#paths = paths;
	}

	getAllSessions(): ChatSession[] {
		return [...this.#sessions];
	}

	getTranscriptPath(chatId: string): string | undefined {
		return this.#paths.get(chatId);
	}
}

function randomPort(): number {
	return 40_000 + Math.floor(Math.random() * 20_000);
}

function buildConfig(port: number): TelegramBridgeConfig {
	return {
		botToken: "viewer-token",
		owners: [12345],
		uploadDir: "/tmp/telegram-uploads",
		logViewerPort: port,
		idleTimeout: 600,
		maxSessions: 2,
		defaultModel: "claude-sonnet-4-5",
		projects: { spell: "/tmp/spell" },
		users: {},
	};
}

describe("startLogViewer", () => {
	let _stopServer: (() => void) | undefined;
	let baseUrl = "";
	let tempDir = "";

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `telegram-log-viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const transcriptPath = path.join(tempDir, "chat-1001.jsonl");
		const transcript = [
			JSON.stringify({
				type: "message_start",
				message: { role: "user", content: "hello from user" },
			}),
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello from assistant" },
			}),
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting transcript" },
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				intent: "inspect config",
			}),
			JSON.stringify({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "read",
				partialResult: {
					content: [{ type: "text", text: "packages/spell-server/src/telegram/log-viewer/server.ts" }],
				},
			}),
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				isError: false,
			}),
			"{not valid json}",
		].join("\n");
		await Bun.write(transcriptPath, transcript);

		const now = Date.now();
		const sessions: ChatSession[] = [
			{
				chatId: "1001",
				userId: "42",
				project: "spell",
				cwd: "/tmp/spell",
				mode: "telegram-readonly",
				showThinking: false,
				transcriptPath,
				createdAt: now - 60_000,
				lastActiveAt: now,
			},
			{
				chatId: "2002",
				userId: "21",
				project: "infra",
				cwd: "/tmp/infra",
				mode: "telegram-full",
				showThinking: true,
				transcriptPath: path.join(tempDir, "missing.jsonl"),
				createdAt: now - 120_000,
				lastActiveAt: now - 30_000,
			},
		];
		const provider = new MockSessionProvider(
			sessions,
			new Map([
				["1001", transcriptPath],
				["2002", path.join(tempDir, "missing.jsonl")],
			]),
		);

		for (let attempt = 0; attempt < 6; attempt++) {
			const port = randomPort();
			const config = buildConfig(port);
			const s = startLogViewer(config, provider);
			if (s) {
				_stopServer = () => s.stop(true);
				baseUrl = `http://127.0.0.1:${port}`;
				break;
			}
		}

		if (!baseUrl) {
			throw new Error("Log viewer server failed to start");
		}
		await Bun.sleep(20);
	});

	afterAll(async () => {
		_stopServer?.();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("returns HTML list for GET /", async () => {
		const response = await fetch(`${baseUrl}/`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");

		const html = await response.text();
		expect(html).toContain("Active Telegram Sessions");
		expect(html).toContain("1001");
		expect(html).toContain("spell");
	});

	it("renders transcript for GET /session/:chatId", async () => {
		const response = await fetch(`${baseUrl}/session/1001`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");

		const html = await response.text();
		expect(html).toContain("hello from user");
		expect(html).toContain("hello from assistant");
		expect(html).toContain("Inspecting transcript");
		expect(html).toContain("Tool read");
		expect(html).toContain("packages/spell-server/src/telegram/log-viewer/server.ts");
	});

	it("renders empty state when session file is missing", async () => {
		const response = await fetch(`${baseUrl}/session/2002`);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("no messages yet");
	});

	it("returns 404 for unknown routes", async () => {
		const response = await fetch(`${baseUrl}/does-not-exist`);
		expect(response.status).toBe(404);
	});
});
