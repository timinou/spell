import { logger } from "@oh-my-pi/pi-utils";
import { RpcClient, type RpcEvent, type RpcSpawnOptions } from "../rpc";
import type { BaseSpawnOptions, SessionEntry, SessionLifecycle } from "./types";

interface SessionManagerOptions<K> {
	lifecycle: SessionLifecycle<K>;
	keyToString: (key: K) => string;
	maxSessions?: number;
	createClient?: (options: RpcSpawnOptions) => RpcClient;
	now?: () => number;
}

interface ManagedSessionEntry<K> extends SessionEntry<K> {
	listener: (event: RpcEvent) => void;
}

export class SessionManager<K> {
	#lifecycle: SessionLifecycle<K>;
	#sessions = new Map<string, ManagedSessionEntry<K>>();
	#pending = new Map<string, Promise<RpcClient>>();
	#keyToString: (key: K) => string;
	#maxSessions: number;
	#createClient: (options: RpcSpawnOptions) => RpcClient;
	#now: () => number;

	constructor(options: SessionManagerOptions<K>) {
		this.#lifecycle = options.lifecycle;
		this.#keyToString = options.keyToString;
		this.#maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
		this.#createClient = options.createClient ?? (spawnOptions => new RpcClient(spawnOptions));
		this.#now = options.now ?? (() => Date.now());
	}

	async getOrCreate(key: K, baseOptions: BaseSpawnOptions): Promise<RpcClient> {
		const sessionKey = this.#keyToString(key);
		const existing = this.#sessions.get(sessionKey);
		if (existing?.client.alive) {
			this.#resetIdleTimer(existing);
			return existing.client;
		}
		if (existing) {
			await this.#disposeEntry(sessionKey, existing, { killClient: true, invokeComplete: false });
		}

		const pending = this.#pending.get(sessionKey);
		if (pending) {
			return pending;
		}
		if (this.#sessions.size + this.#pending.size >= this.#maxSessions) {
			throw new Error(`Max sessions limit reached (${this.#maxSessions}) for session '${sessionKey}'`);
		}

		const creation = this.#startSession(key, sessionKey, baseOptions);
		this.#pending.set(sessionKey, creation);
		try {
			return await creation;
		} finally {
			this.#pending.delete(sessionKey);
		}
	}

	get(key: K): RpcClient | undefined {
		return this.#sessions.get(this.#keyToString(key))?.client;
	}

	async kill(key: K): Promise<void> {
		const sessionKey = this.#keyToString(key);
		const entry = this.#sessions.get(sessionKey);
		if (!entry) return;
		await this.#disposeEntry(sessionKey, entry, { killClient: true, invokeComplete: true });
	}

	async killAll(): Promise<void> {
		const entries = [...this.#sessions.entries()];
		await Promise.allSettled(
			entries.map(([sessionKey, entry]) =>
				this.#disposeEntry(sessionKey, entry, { killClient: true, invokeComplete: true }),
			),
		);
	}

	getActive(): Map<string, SessionEntry<K>> {
		return new Map(this.#sessions.entries());
	}

	get size(): number {
		return this.#sessions.size;
	}

	async #startSession(key: K, sessionKey: string, baseOptions: BaseSpawnOptions): Promise<RpcClient> {
		const spawnOptions = this.#lifecycle.buildSpawnOptions(key, baseOptions);
		const client = this.#createClient(spawnOptions);
		await client.start();

		const entry = {} as ManagedSessionEntry<K>;
		entry.key = key;
		entry.client = client;
		entry.startedAt = this.#now();
		entry.listener = event => {
			if (event.type === "error") {
				void this.#handleSessionError(sessionKey, event.message);
				return;
			}
			this.#resetIdleTimer(entry);
		};

		client.onEvent(entry.listener);
		this.#sessions.set(sessionKey, entry);
		this.#resetIdleTimer(entry);
		return client;
	}

	#resetIdleTimer(entry: ManagedSessionEntry<K>): void {
		this.#clearIdleTimer(entry);
		const idleTimeout = this.#lifecycle.getIdleTimeout(entry.key);
		if (idleTimeout === null) return;

		entry.timer = setTimeout(() => {
			void this.kill(entry.key).catch(error => {
				logger.error("Failed to kill idle session", {
					key: this.#keyToString(entry.key),
					error: String(error),
				});
			});
		}, idleTimeout);
		if (entry.timer && "unref" in entry.timer) {
			(entry.timer as NodeJS.Timeout).unref();
		}
	}

	#clearIdleTimer(entry: SessionEntry<K>): void {
		if (!entry.timer) return;
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	async #handleSessionError(sessionKey: string, message: string): Promise<void> {
		const entry = this.#sessions.get(sessionKey);
		if (!entry) return;
		const error = new Error(`Session '${sessionKey}' failed: ${message}`);
		await this.#disposeEntry(sessionKey, entry, { killClient: false, invokeComplete: false });
		await this.#lifecycle.onSessionError?.(entry.key, error);
	}

	async #disposeEntry(
		sessionKey: string,
		entry: ManagedSessionEntry<K>,
		options: { killClient: boolean; invokeComplete: boolean },
	): Promise<void> {
		const current = this.#sessions.get(sessionKey);
		if (current !== entry) return;

		this.#sessions.delete(sessionKey);
		this.#clearIdleTimer(entry);
		entry.client.offEvent(entry.listener);

		let completionError: Error | null = null;
		if (options.killClient) {
			try {
				await entry.client.kill();
			} catch (error) {
				completionError = error instanceof Error ? error : new Error(String(error));
			}
		}

		if (options.invokeComplete) {
			try {
				await this.#lifecycle.onSessionComplete?.(entry.key);
			} catch (error) {
				if (!completionError) {
					completionError = error instanceof Error ? error : new Error(String(error));
				}
			}
		}

		if (completionError) {
			throw completionError;
		}
	}
}
