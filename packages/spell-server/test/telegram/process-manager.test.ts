import { describe, expect, it } from "bun:test";
import { RpcClient } from "../../src/rpc/rpc-client";
import type { BridgeRpcCommand, ImageContentRef, RpcEvent, RpcSpawnOptions } from "../../src/rpc/types";
import { ProcessManager } from "../../src/telegram/process-manager";
import type { TelegramBridgeConfig } from "../../src/telegram/types";

class MockRpcClient extends RpcClient {
	spawnOptions: RpcSpawnOptions;
	startCalls = 0;
	killCalls = 0;
	sentCommands: BridgeRpcCommand[] = [];
	#alive = false;
	#listeners: Array<(event: RpcEvent) => void> = [];

	constructor(options: RpcSpawnOptions) {
		super(options);
		this.spawnOptions = options;
	}

	override get alive(): boolean {
		return this.#alive;
	}

	override async start(): Promise<void> {
		this.startCalls += 1;
		this.#alive = true;
	}

	override send(command: BridgeRpcCommand): void {
		this.sentCommands.push(command);
	}

	override onEvent(callback: (event: RpcEvent) => void): void {
		this.#listeners.push(callback);
	}

	override async prompt(message: string, images?: ImageContentRef[]): Promise<void> {
		this.sentCommands.push({ type: "prompt", message, images });
	}

	override async abort(): Promise<void> {
		this.sentCommands.push({ type: "abort" });
	}

	override async kill(): Promise<void> {
		this.killCalls += 1;
		this.#alive = false;
		this.emit({ type: "error", message: "mock process killed" });
	}

	emit(event: RpcEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

function createConfig(overrides: Partial<TelegramBridgeConfig> = {}): TelegramBridgeConfig {
	return {
		botToken: "token",
		owners: [12345],
		uploadDir: "/tmp/uploads",
		idleTimeout: 60,
		maxSessions: 3,
		projects: {
			spell: "/tmp/project-spell",
			infra: "/tmp/project-infra",
		},
		users: {
			"user-1": {
				modes: ["telegram-readonly"],
				defaultMode: "telegram-readonly",
				idleTimeout: 60,
			},
			owner: {
				modes: ["telegram-full"],
				defaultMode: "telegram-full",
				idleTimeout: null,
			},
		},
		...overrides,
	};
}

describe("ProcessManager", () => {
	it("creates a new session for unknown chat id", async () => {
		const clients: MockRpcClient[] = [];
		const manager = new ProcessManager(createConfig(), {
			createClient: options => {
				const client = new MockRpcClient(options);
				clients.push(client);
				return client;
			},
		});

		const client = await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});

		expect(client).toBe(clients[0]);
		expect(clients[0]?.startCalls).toBe(1);

		const sessions = manager.getActiveSessions();
		expect(sessions.size).toBe(1);
		expect(sessions.get("chat-1")?.project).toBe("spell");

		await manager.killAll();
	});

	it("returns existing session for known chat id", async () => {
		const clients: MockRpcClient[] = [];
		const manager = new ProcessManager(createConfig(), {
			createClient: options => {
				const client = new MockRpcClient(options);
				clients.push(client);
				return client;
			},
		});

		const first = await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});
		const second = await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});

		expect(second).toBe(first);
		expect(clients.length).toBe(1);

		await manager.killAll();
	});

	it("respects maxSessions limit", async () => {
		const manager = new ProcessManager(createConfig({ maxSessions: 1 }), {
			createClient: options => new MockRpcClient(options),
		});

		await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});

		await expect(
			manager.getOrCreate("chat-2", "user-1", {
				project: "infra",
				mode: "telegram-readonly",
				tools: ["read"],
			}),
		).rejects.toThrow("Max sessions limit reached");

		await manager.killAll();
	});

	it("kills session when idle timeout fires", async () => {
		const clients: MockRpcClient[] = [];
		const manager = new ProcessManager(
			createConfig({
				idleTimeout: 0.03,
				users: {
					"user-1": {
						modes: ["telegram-readonly"],
						defaultMode: "telegram-readonly",
						idleTimeout: 0.03,
					},
					owner: {
						modes: ["telegram-full"],
						defaultMode: "telegram-full",
						idleTimeout: null,
					},
				},
			}),
			{
				createClient: options => {
					const client = new MockRpcClient(options);
					clients.push(client);
					return client;
				},
			},
		);

		await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});

		await Bun.sleep(120);

		expect(manager.get("chat-1")).toBeUndefined();
		expect(clients[0]?.killCalls).toBe(1);

		await manager.killAll();
	});

	it("does not auto-kill owner session with null idleTimeout", async () => {
		const clients: MockRpcClient[] = [];
		const manager = new ProcessManager(
			createConfig({
				idleTimeout: 0.03,
				users: {
					"user-1": {
						modes: ["telegram-readonly"],
						defaultMode: "telegram-readonly",
						idleTimeout: 0.03,
					},
					owner: {
						modes: ["telegram-full"],
						defaultMode: "telegram-full",
						idleTimeout: null,
					},
				},
			}),
			{
				createClient: options => {
					const client = new MockRpcClient(options);
					clients.push(client);
					return client;
				},
			},
		);

		await manager.getOrCreate("chat-owner", "owner", {
			project: "spell",
			mode: "telegram-full",
			tools: ["read"],
		});

		await Bun.sleep(120);

		expect(manager.get("chat-owner")).toBeDefined();
		expect(clients[0]?.killCalls).toBe(0);

		await manager.killAll();
	});

	it("loads prior state and persists session changes", async () => {
		const clients: MockRpcClient[] = [];
		const savedSnapshots: Array<Record<string, string | undefined>> = [];
		const manager = new ProcessManager(createConfig(), {
			createClient: options => {
				const client = new MockRpcClient(options);
				clients.push(client);
				return client;
			},
			loadState: async () => ({
				sessions: {
					"chat-1": {
						sessionPath: "/tmp/restored-session.json",
						project: "spell",
						mode: "telegram-readonly",
						userId: "user-1",
					},
				},
			}),
			saveState: async sessions => {
				const snapshot: Record<string, string | undefined> = {};
				for (const [chatId, session] of sessions) {
					snapshot[chatId] = session.sessionPath;
				}
				savedSnapshots.push(snapshot);
			},
		});

		await manager.loadState();
		await manager.getOrCreate("chat-1", "user-1", {
			project: "spell",
			mode: "telegram-readonly",
			tools: ["read"],
		});

		expect(clients[0]?.spawnOptions.sessionPath).toBe("/tmp/restored-session.json");
		expect(savedSnapshots.length).toBeGreaterThan(0);
		expect(savedSnapshots.at(-1)?.["chat-1"]).toBe("/tmp/restored-session.json");

		await manager.killAll();
	});
});
