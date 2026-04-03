import { describe, expect, it } from "bun:test";
import type { ChatSession } from "../../src/rpc/bridge-types";
import type { AuthContext } from "../../src/telegram/bot/auth";
import type { CommandContext } from "../../src/telegram/commands";
import { handleClearCommand } from "../../src/telegram/commands/session-commands";
import { handleVoiceCommand } from "../../src/telegram/commands/voice";
import type { ProcessManager } from "../../src/telegram/process-manager";
import type { TelegramBridgeConfig } from "../../src/telegram/types";

function createMockCtx(text: string, chatId = "123"): AuthContext & { _replies: string[] } {
	const replies: string[] = [];
	return {
		message: { text, chat: { id: Number(chatId), type: "private" } },
		chat: { id: Number(chatId), type: "private" },
		reply: async (msg: string) => {
			replies.push(msg);
			return { message_id: replies.length, chat: { id: Number(chatId) }, date: Math.floor(Date.now() / 1000) };
		},
		authState: { userId: "user1", isOwner: true, userConfig: { modes: [], defaultMode: "" } },
		_replies: replies,
	} as any;
}

class MockProcessManager {
	sessions = new Map<string, ChatSession>();
	saveStateCalls = 0;
	readonly #clients = new Map<string, { send: (command: { type: string }) => void }>();

	get(chatId: string): { send: (command: { type: string }) => void } | undefined {
		return this.#clients.get(chatId);
	}

	setClient(chatId: string, client: { send: (command: { type: string }) => void }): void {
		this.#clients.set(chatId, client);
	}

	getSession(chatId: string): ChatSession | undefined {
		return this.sessions.get(chatId);
	}

	async saveState(): Promise<void> {
		this.saveStateCalls += 1;
	}
}

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
	const now = Date.now();
	return {
		chatId: "123",
		userId: "user1",
		project: "spell",
		cwd: "/tmp/spell",
		mode: "telegram-full",
		showThinking: false,
		createdAt: now,
		lastActiveAt: now,
		...overrides,
	};
}

function createCommandContext(
	processManager: MockProcessManager,
	configOverrides: Partial<TelegramBridgeConfig> = {},
): CommandContext {
	const config: TelegramBridgeConfig = {
		botToken: "123:token",
		owners: [1],
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 2,
		autoSendImages: true,
		defaultModel: "claude-sonnet-4-5",
		projects: { spell: "/tmp/spell" },
		users: {},
		voice: { replyMode: "mirror" },
		...configOverrides,
	};

	return {
		config,
		processManager: processManager as unknown as ProcessManager,
		telegramPrompt: "prompt",
	};
}

describe("handleVoiceCommand", () => {
	it("cycles from no override to mirror", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession());
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.getSession("123")?.voiceReplyOverride).toBe("mirror");
		expect(processManager.saveStateCalls).toBe(1);
		expect(ctx._replies).toEqual(["Voice reply mode: mirror"]);
	});

	it("sets always for /voice on", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession());
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice on");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.getSession("123")?.voiceReplyOverride).toBe("always");
		expect(ctx._replies).toEqual(["Voice reply mode: always"]);
	});

	it("sets never for /voice off", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession({ voiceReplyOverride: "always" }));
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice off");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.getSession("123")?.voiceReplyOverride).toBe("never");
		expect(ctx._replies).toEqual(["Voice reply mode: never"]);
	});

	it("sets mirror for /voice mirror", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession({ voiceReplyOverride: "never" }));
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice mirror");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.getSession("123")?.voiceReplyOverride).toBe("mirror");
		expect(ctx._replies).toEqual(["Voice reply mode: mirror"]);
	});

	it("wraps toggle cycle from always to never", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession({ voiceReplyOverride: "always" }));
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.getSession("123")?.voiceReplyOverride).toBe("never");
		expect(ctx._replies).toEqual(["Voice reply mode: never"]);
	});

	it("reports effective mode for /voice status", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession({ voiceReplyOverride: "always" }));
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice status");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.saveStateCalls).toBe(0);
		expect(ctx._replies).toEqual(["Voice reply mode: always (session)"]);
	});

	it("replies when no session exists", async () => {
		const processManager = new MockProcessManager();
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/voice");

		await handleVoiceCommand(ctx, cmdCtx);

		expect(processManager.saveStateCalls).toBe(0);
		expect(ctx._replies).toEqual(["No active session. Send a message to start one."]);
	});
	it("clears session voice override on /clear", async () => {
		const processManager = new MockProcessManager();
		processManager.sessions.set("123", createSession({ voiceReplyOverride: "always" }));
		const sentCommands: Array<{ type: string }> = [];
		processManager.setClient("123", {
			send: command => {
				sentCommands.push(command);
			},
		});
		const cmdCtx = createCommandContext(processManager);
		const ctx = createMockCtx("/clear");

		await handleClearCommand(ctx, cmdCtx);

		expect(sentCommands).toEqual([{ type: "new_session" }]);
		expect(processManager.getSession("123")?.voiceReplyOverride).toBeUndefined();
		expect(processManager.saveStateCalls).toBe(1);
		expect(ctx._replies).toEqual(["Started a new session."]);
	});
});
