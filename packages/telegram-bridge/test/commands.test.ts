import { describe, expect, it } from "bun:test";
import type { AuthContext } from "../src/bot/auth";
import { COMMANDS, type CommandContext } from "../src/commands";
import { handleBtwCommand } from "../src/commands/btw";
import { handleModeCommand } from "../src/commands/mode";
import { handleProjectCommand } from "../src/commands/project";
import { handleClearCommand, handleStatusCommand, handleThinkCommand } from "../src/commands/session-commands";
import { handleHelpCommand } from "../src/commands/start-help";
import { handleLockCommand, handleUnlockCommand } from "../src/commands/unlock-lock";
import type { TelegramBridgeConfig } from "../src/config/types";
import type { ProcessManager } from "../src/rpc/process-manager";
import type { RpcClient } from "../src/rpc/rpc-client";
import type { BridgeRpcCommand, RpcEvent, RpcSpawnOptions } from "../src/rpc/types";
import type { ChatSession } from "../src/types";

interface MockAuthContextOptions {
	userId?: string;
	chatId?: number;
	isOwner?: boolean;
	text?: string;
	modes?: string[];
	defaultMode?: string;
}

interface MockReply {
	text: string;
	options?: Record<string, unknown>;
}

type MockAuthContext = AuthContext & {
	_replies: MockReply[];
	_editedMessages: MockReply[];
};

function mockAuthContext(opts: MockAuthContextOptions): MockAuthContext {
	const replies: MockReply[] = [];
	const editedMessages: MockReply[] = [];
	const userId = opts.userId ?? "123456789";
	const chatId = opts.chatId ?? 12345;

	return {
		from: { id: Number(userId) },
		chat: { id: chatId, type: "private" as const },
		message: {
			text: opts.text ?? "",
			message_id: 1,
			date: Math.floor(Date.now() / 1000),
			chat: { id: chatId, type: "private" as const },
		},
		reply: async (text: string, options?: Record<string, unknown>) => {
			replies.push({ text, options });
			return { message_id: 2, chat: { id: chatId }, date: Math.floor(Date.now() / 1000) };
		},
		editMessageText: async (text: string, options?: Record<string, unknown>) => {
			editedMessages.push({ text, options });
		},
		answerCallbackQuery: async () => {},
		authState: {
			userId,
			isOwner: opts.isOwner ?? true,
			userConfig: {
				modes: opts.modes ?? ["telegram-readonly", "telegram-full"],
				defaultMode: opts.defaultMode ?? "telegram-readonly",
			},
		},
		_replies: replies,
		_editedMessages: editedMessages,
	} as unknown as MockAuthContext;
}

class MockRpcClient {
	spawnOptions: RpcSpawnOptions | null = null;
	startCalls = 0;
	promptCalls: string[] = [];
	killCalls = 0;
	sentCommands: BridgeRpcCommand[] = [];
	#listeners: Array<(event: RpcEvent) => void> = [];

	onEvent(callback: (event: RpcEvent) => void): void {
		this.#listeners.push(callback);
	}

	emit(event: RpcEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	send(command: BridgeRpcCommand): void {
		this.sentCommands.push(command);
	}

	async start(): Promise<void> {
		this.startCalls += 1;
	}

	async prompt(message: string): Promise<void> {
		this.promptCalls.push(message);
		this.emit({ type: "message_end" });
	}

	async kill(): Promise<void> {
		this.killCalls += 1;
	}
}

type CreatedSessionOptions = {
	project: string;
	mode: string;
	tools: string[];
	appendSystemPrompt?: string;
	sessionPath?: string;
};

class MockProcessManager {
	sessions = new Map<string, ChatSession>();
	clients = new Map<string, MockRpcClient>();
	killedChats: string[] = [];
	createdSessions: Array<{
		chatId: string;
		userId: string;
		options: CreatedSessionOptions;
	}> = [];
	saveStateCalls = 0;

	get(chatId: string): RpcClient | undefined {
		const client = this.clients.get(chatId);
		return client as unknown as RpcClient;
	}

	async getOrCreate(chatId: string, userId: string, options: CreatedSessionOptions): Promise<RpcClient> {
		this.createdSessions.push({ chatId, userId, options });
		const client = this.clients.get(chatId) ?? new MockRpcClient();
		this.clients.set(chatId, client);

		const now = Date.now();
		this.sessions.set(chatId, {
			chatId,
			userId,
			project: options.project,
			cwd: `/tmp/${options.project}`,
			mode: options.mode,
			showThinking: false,
			createdAt: now,
			lastActiveAt: now,
		});

		return client as unknown as RpcClient;
	}

	async kill(chatId: string): Promise<void> {
		this.killedChats.push(chatId);
		this.sessions.delete(chatId);
		this.clients.delete(chatId);
	}

	async killAll(): Promise<void> {}

	getActiveSessions(): Map<string, ChatSession> {
		return new Map(this.sessions);
	}

	getSession(chatId: string): ChatSession | undefined {
		return this.sessions.get(chatId);
	}

	async loadState(): Promise<void> {}

	async saveState(): Promise<void> {
		this.saveStateCalls += 1;
	}
}

function mockCommandContext(): {
	config: TelegramBridgeConfig;
	processManager: MockProcessManager;
	cmdCtx: CommandContext & { telegramPrompt: string };
	telegramPrompt: string;
} {
	const config: TelegramBridgeConfig = {
		botTokenFile: "/tmp/bot-token.txt",
		botToken: "123:token",
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 2,
		projects: {
			spell: "/tmp/spell",
			infra: "/tmp/infra",
		},
		users: {
			"123456789": {
				modes: ["telegram-readonly", "telegram-full"],
				defaultMode: "telegram-readonly",
			},
		},
		defaultProject: "spell",
	};
	const processManager = new MockProcessManager();
	const telegramPrompt = "Test telegram prompt";
	const cmdCtx: CommandContext & { telegramPrompt: string } = {
		config,
		processManager: processManager as unknown as ProcessManager,
		telegramPrompt,
	};
	return { config, processManager, cmdCtx, telegramPrompt };
}

describe("telegram command handlers", () => {
	it("/help returns formatted list of all commands", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/help" });

		await handleHelpCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies).toHaveLength(1);
		const helpText = (ctx as { _replies: MockReply[] })._replies[0]?.text ?? "";
		for (const command of COMMANDS) {
			expect(helpText).toContain(`/${command.command} — ${command.description}`);
		}
	});

	it("/unlock from owner shows confirmation keyboard", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ isOwner: true, text: "/unlock" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});

		await handleUnlockCommand(ctx, cmdCtx);

		const replies = (ctx as { _replies: MockReply[] })._replies;
		expect(replies[0]?.text).toContain("Switch to full access mode?");
		expect(replies[0]?.options?.reply_markup).toBeDefined();
	});

	it("/unlock from guest is rejected", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ isOwner: false, text: "/unlock" });

		await handleUnlockCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Not authorized");
	});

	it("/lock switches mode and confirms", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/lock" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-full",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});
		processManager.clients.set("12345", new MockRpcClient());

		await handleLockCommand(ctx, cmdCtx);

		expect(processManager.killedChats).toEqual(["12345"]);
		expect(processManager.createdSessions[0]?.options.mode).toBe("telegram-readonly");
		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Switched to read-only mode.");
	});

	it("/project with no args lists projects", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/project" });

		await handleProjectCommand(ctx, cmdCtx);

		const reply = (ctx as { _replies: MockReply[] })._replies[0];
		expect(reply?.text).toBe("Select a project:");
		expect(reply?.options?.reply_markup).toBeDefined();
	});

	it("/project spell switches project", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/project spell" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "infra",
			cwd: "/tmp/infra",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});
		processManager.clients.set("12345", new MockRpcClient());

		await handleProjectCommand(ctx, cmdCtx);

		expect(processManager.killedChats).toEqual(["12345"]);
		expect(processManager.createdSessions[0]?.options.project).toBe("spell");
		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Switched to project: spell");
	});

	it("/project spell respawns with telegram prompt", async () => {
		const { cmdCtx, processManager, telegramPrompt } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/project spell" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "infra",
			cwd: "/tmp/infra",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});
		processManager.clients.set("12345", new MockRpcClient());

		await handleProjectCommand(ctx, cmdCtx);

		expect(processManager.createdSessions[0]?.options.appendSystemPrompt).toBe(telegramPrompt);
	});

	it("/think toggles and shows current state", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/think" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});

		await handleThinkCommand(ctx, cmdCtx);

		expect(processManager.sessions.get("12345")?.showThinking).toBe(true);
		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Thinking is now visible.");
	});

	it("/clear with no active session replies no session", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/clear" });

		await handleClearCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("No active session");
	});

	it("/status shows session info when active", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/status" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now() - 2 * 60 * 60 * 1000,
			lastActiveAt: Date.now(),
		});

		await handleStatusCommand(ctx, cmdCtx);

		const text = (ctx as { _replies: MockReply[] })._replies[0]?.text ?? "";
		expect(text).toContain("Project: spell");
		expect(text).toContain("Mode: telegram-readonly");
		expect(text).toContain("Session: active");
		expect(text).toContain("Thinking: hidden");
	});

	it("/status shows no session when inactive", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/status" });

		await handleStatusCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe(
			"No active session. Send a message to start one.",
		);
	});

	it("/btw with question text works", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/btw explain this" });
		const streamerEvents: RpcEvent[] = [];
		let spawnOptions: RpcSpawnOptions | undefined;
		const client = new MockRpcClient();

		await handleBtwCommand(ctx, cmdCtx, {
			createClient: options => {
				spawnOptions = options;
				client.spawnOptions = options;
				return client as unknown as RpcClient;
			},
			createStreamer: () => {
				const { promise, resolve } = Promise.withResolvers<void>();
				return {
					handleEvent: async (event: RpcEvent) => {
						streamerEvents.push(event);
						if (event.type === "message_end" || event.type === "agent_end") {
							resolve();
						}
					},
					done: promise,
					cancel: () => resolve(),
				};
			},
			loadPrompt: async () => "Telegram prompt",
		});

		expect(client.startCalls).toBe(1);
		expect(client.promptCalls).toEqual(["explain this"]);
		expect(client.killCalls).toBe(1);
		expect(streamerEvents.some(event => event.type === "message_end")).toBe(true);
		expect(spawnOptions?.noSession).toBe(true);
	});

	it("/unlock when already unlocked reports already", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/unlock", isOwner: true });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-full",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});

		await handleUnlockCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Already in full access mode");
	});

	it("/lock when already locked reports already", async () => {
		const { cmdCtx, processManager } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/lock" });
		processManager.sessions.set("12345", {
			chatId: "12345",
			userId: "123456789",
			project: "spell",
			cwd: "/tmp/spell",
			mode: "telegram-readonly",
			showThinking: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		});

		await handleLockCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Already in read-only mode");
	});

	it("/project unknown project shows available list", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/project unknown" });

		await handleProjectCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toContain("Available projects:");
	});

	it("/btw with empty question shows usage", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/btw" });

		await handleBtwCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toBe("Usage: /btw <question>");
	});

	it("/mode unknown mode shows available list", async () => {
		const { cmdCtx } = mockCommandContext();
		const ctx = mockAuthContext({ text: "/mode invalid" });

		await handleModeCommand(ctx, cmdCtx);

		expect((ctx as { _replies: MockReply[] })._replies[0]?.text).toContain("Available modes:");
	});
});

it("/mode telegram-full respawns with telegram prompt", async () => {
	const { cmdCtx, processManager, telegramPrompt } = mockCommandContext();
	const ctx = mockAuthContext({ text: "/mode telegram-full" });
	processManager.sessions.set("12345", {
		chatId: "12345",
		userId: "123456789",
		project: "spell",
		cwd: "/tmp/spell",
		mode: "telegram-readonly",
		showThinking: false,
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
	});
	processManager.clients.set("12345", new MockRpcClient());

	await handleModeCommand(ctx, cmdCtx);

	expect(processManager.createdSessions[0]?.options.mode).toBe("telegram-full");
	expect(processManager.createdSessions[0]?.options.appendSystemPrompt).toBe(telegramPrompt);
});
