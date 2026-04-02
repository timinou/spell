import { logger } from "@oh-my-pi/pi-utils";
import type { TelegramBridgeConfig } from "../config/types";
import type { BridgeState, ChatSession } from "../types";
import { RpcClient } from "./rpc-client";
import { loadBridgeState, saveBridgeState } from "./state";
import type { RpcSpawnOptions } from "./types";

interface SessionEntry {
	client: RpcClient;
	session: ChatSession;
	timer?: Timer;
}

interface SessionOptions {
	project: string;
	mode: string;
	tools: string[];
	sessionPath?: string;
}

interface ProcessManagerDependencies {
	createClient?: (options: RpcSpawnOptions) => RpcClient;
	saveState?: (sessions: Map<string, ChatSession>) => Promise<void>;
	loadState?: () => Promise<BridgeState>;
	now?: () => number;
}

export class ProcessManager {
	#config: TelegramBridgeConfig;
	#sessions: Map<string, { client: RpcClient; session: ChatSession; timer?: Timer }> = new Map();
	#restoredSessions: BridgeState["sessions"] = {};
	#createClient: (options: RpcSpawnOptions) => RpcClient;
	#saveState: (sessions: Map<string, ChatSession>) => Promise<void>;
	#loadState: () => Promise<BridgeState>;
	#now: () => number;

	constructor(config: TelegramBridgeConfig, dependencies: ProcessManagerDependencies = {}) {
		this.#config = config;
		this.#createClient = dependencies.createClient ?? (options => new RpcClient(options));
		this.#saveState = dependencies.saveState ?? saveBridgeState;
		this.#loadState = dependencies.loadState ?? loadBridgeState;
		this.#now = dependencies.now ?? (() => Date.now());
	}

	async loadState(): Promise<void> {
		const state = await this.#loadState();
		this.#restoredSessions = state.sessions;
	}

	get(chatId: string): RpcClient | undefined {
		return this.#sessions.get(chatId)?.client;
	}

	async getOrCreate(chatId: string, userId: string, options: SessionOptions): Promise<RpcClient> {
		const existing = this.#sessions.get(chatId);
		if (existing?.client.alive) {
			existing.session.lastActiveAt = this.#now();
			this.#resetIdleTimer(chatId, existing.session.userId, existing);
			return existing.client;
		}
		if (existing) {
			await this.kill(chatId);
		}

		if (this.#sessions.size >= this.#config.maxSessions) {
			throw new Error(`Max sessions limit reached (${this.#config.maxSessions})`);
		}

		const cwd = this.#config.projects[options.project];
		if (!cwd) {
			throw new Error(`Unknown project '${options.project}'`);
		}

		const restored = this.#restoredSessions[chatId];
		const sessionPath = options.sessionPath ?? restored?.sessionPath;
		const spawnOptions: RpcSpawnOptions = {
			cwd,
			tools: options.tools,
			sessionPath,
		};

		const client = this.#createClient(spawnOptions);
		await client.start();

		const now = this.#now();
		const session: ChatSession = {
			chatId,
			userId,
			project: options.project,
			cwd,
			mode: options.mode,
			showThinking: false,
			sessionPath,
			createdAt: now,
			lastActiveAt: now,
		};

		const entry: SessionEntry = { client, session };
		this.#sessions.set(chatId, entry);

		client.onEvent(event => {
			const current = this.#sessions.get(chatId);
			if (!current) return;
			current.session.lastActiveAt = this.#now();
			if (event.type === "error") {
				this.#clearIdleTimer(current);
				this.#sessions.delete(chatId);
				delete this.#restoredSessions[chatId];
				void this.#persistState();
				return;
			}
			this.#resetIdleTimer(chatId, current.session.userId, current);
		});

		this.#resetIdleTimer(chatId, userId, entry);
		await this.#persistState();
		return client;
	}

	async kill(chatId: string): Promise<void> {
		const entry = this.#sessions.get(chatId);
		if (!entry) return;

		this.#clearIdleTimer(entry);
		this.#sessions.delete(chatId);
		delete this.#restoredSessions[chatId];

		await entry.client.kill();
		await this.#persistState();
	}

	async killAll(): Promise<void> {
		const entries = [...this.#sessions.values()];
		this.#sessions.clear();
		this.#restoredSessions = {};

		for (const entry of entries) {
			this.#clearIdleTimer(entry);
		}

		await Promise.allSettled(entries.map(entry => entry.client.kill()));
		await this.#persistState();
	}

	getActiveSessions(): Map<string, ChatSession> {
		const active = new Map<string, ChatSession>();
		for (const [chatId, entry] of this.#sessions) {
			active.set(chatId, entry.session);
		}
		return active;
	}

	/** Public handle for shutdown hooks to persist state */
	async saveState(): Promise<void> {
		await this.#persistState();
	}

	/** Get session info for a specific chat */
	getSession(chatId: string): ChatSession | undefined {
		return this.#sessions.get(chatId)?.session;
	}

	/** Get all sessions as array (implements SessionProvider) */
	getAllSessions(): ChatSession[] {
		return [...this.getActiveSessions().values()];
	}

	/** Get session path for a chat (implements SessionProvider) */
	getSessionPath(chatId: string): string | undefined {
		return this.#sessions.get(chatId)?.session.sessionPath;
	}

	#resolveIdleTimeout(userId: string): number | null {
		const userConfig = this.#config.users[userId];
		if (userConfig?.idleTimeout === null) return null;
		if (typeof userConfig?.idleTimeout === "number") return userConfig.idleTimeout;
		return this.#config.idleTimeout;
	}

	#resetIdleTimer(chatId: string, userId: string, entry: SessionEntry): void {
		this.#clearIdleTimer(entry);

		const timeoutSeconds = this.#resolveIdleTimeout(userId);
		if (timeoutSeconds === null) return;

		entry.timer = setTimeout(() => {
			void this.kill(chatId).catch(error => {
				logger.error("Failed to kill idle RPC session", { chatId, error: String(error) });
			});
		}, timeoutSeconds * 1000);

		if (entry.timer && "unref" in entry.timer) {
			(entry.timer as NodeJS.Timeout).unref();
		}
	}

	#clearIdleTimer(entry: SessionEntry): void {
		if (!entry.timer) return;
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	async #persistState(): Promise<void> {
		const sessions = this.getActiveSessions();
		await this.#saveState(sessions);
	}
}
