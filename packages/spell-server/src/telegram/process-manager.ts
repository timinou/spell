import { logger } from "@oh-my-pi/pi-utils";
import type { BridgeState, ChatSession } from "../rpc/bridge-types";
import { RpcClient } from "../rpc/rpc-client";
import { loadBridgeState, saveBridgeState } from "../rpc/state";
import type { RpcSpawnOptions } from "../rpc/types";
import { createRpcTranscriptWriter, type RpcTranscriptWriter } from "./transcript-store";
import type { TelegramBridgeConfig } from "./types";

interface SessionEntry {
	client: RpcClient;
	session: ChatSession;
	transcript: RpcTranscriptWriter;
	timer?: Timer;
}

interface SessionOptions {
	project: string;
	mode: string;
	tools: string[];
	appendSystemPrompt?: string;
	sessionPath?: string;
}

interface ProcessManagerDependencies {
	createClient?: (options: RpcSpawnOptions) => RpcClient;
	createTranscriptWriter?: (chatId: string, createdAt: number, restoredPath?: string) => Promise<RpcTranscriptWriter>;
	saveState?: (sessions: Map<string, ChatSession>) => Promise<void>;
	loadState?: () => Promise<BridgeState>;
	now?: () => number;
}

export class ProcessManager {
	#config: TelegramBridgeConfig;
	#sessions: Map<string, SessionEntry> = new Map();
	#restoredSessions: BridgeState["sessions"] = {};
	#createClient: (options: RpcSpawnOptions) => RpcClient;
	#createTranscriptWriter: (chatId: string, createdAt: number, restoredPath?: string) => Promise<RpcTranscriptWriter>;
	#saveState: (sessions: Map<string, ChatSession>) => Promise<void>;
	#loadState: () => Promise<BridgeState>;
	#now: () => number;

	constructor(config: TelegramBridgeConfig, dependencies: ProcessManagerDependencies = {}) {
		this.#config = config;
		this.#createClient = dependencies.createClient ?? (options => new RpcClient(options));
		this.#createTranscriptWriter =
			dependencies.createTranscriptWriter ??
			((chatId, createdAt, restoredPath) =>
				createRpcTranscriptWriter(this.#config.uploadDir, chatId, createdAt, restoredPath));
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
		const now = this.#now();
		const transcript = await this.#createTranscriptWriter(chatId, now, restored?.transcriptPath);
		const spawnOptions: RpcSpawnOptions = {
			cwd,
			tools: options.tools,
			appendSystemPrompt: options.appendSystemPrompt,
			model: this.#config.defaultModel,
			sessionPath,
		};

		const client = this.#createClient(spawnOptions);
		await client.start();

		const session: ChatSession = {
			chatId,
			userId,
			project: options.project,
			cwd,
			mode: options.mode,
			showThinking: false,
			sessionPath,
			transcriptPath: transcript.path,
			createdAt: now,
			lastActiveAt: now,
		};

		const entry: SessionEntry = { client, session, transcript };
		this.#sessions.set(chatId, entry);

		client.onEvent(event => {
			const current = this.#sessions.get(chatId);
			if (!current) return;
			current.transcript.append(event);
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
		await entry.transcript.flush();
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
		await Promise.allSettled(entries.map(entry => entry.transcript.flush()));
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

	/** Get transcript path for a chat (implements SessionProvider) */
	getTranscriptPath(chatId: string): string | undefined {
		return this.#sessions.get(chatId)?.session.transcriptPath;
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
