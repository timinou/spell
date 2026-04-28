import { logger } from "@oh-my-pi/pi-utils";
import type { BridgeRpcCommand, RpcClient, RpcEvent, RpcResponseEvent } from "../../rpc";
import type { SessionManager } from "../../session/session-manager";
import type { BaseSpawnOptions } from "../../session/types";
import type { SessionRegistryEntry, SocketSessionRegistry } from "../../socket/session-registry";
import type { ArtifactWatcher } from "../artifacts/watcher";

export interface WebSpawnInput {
	ownedBy: string;
	templateName?: string;
	watchExtensions?: string[];
	mode?: string;
	base: BaseSpawnOptions;
	sessionRoot?: string;
}

export interface WebSpawnResult {
	sessionId: string;
}

type LifecycleEvent =
	| { type: "session_added"; sessionId: string }
	| { type: "session_removed"; sessionId: string }
	| { type: "session_updated"; sessionId: string };

type LifecycleListener = (event: LifecycleEvent) => void;
type EventListener = (event: RpcEvent) => void;

interface SpawnedRecord {
	sessionId: string;
	rpcClient: RpcClient;
	listeners: Set<EventListener>;
	rootListener: (event: RpcEvent) => void;
	watchActive: boolean;
}

let spawnedSeq = 0;
function nextSessionId(): string {
	spawnedSeq += 1;
	return `web-${Date.now().toString(36)}-${spawnedSeq.toString(36)}`;
}

export interface WebSessionHubDeps {
	sessionManager: SessionManager<string>;
	registry: SocketSessionRegistry;
	artifactWatcher?: ArtifactWatcher;
}

/**
 * Owns server-spawned RPC sessions for the web frontend. Multiplexes per-
 * session event streams so multiple WS subscribers can listen, and forwards
 * RpcCommands to the underlying RpcClient. External CLI sessions are NOT
 * steerable through this hub \u2014 attempting to send to one throws.
 */
export class WebSessionHub {
	#deps: WebSessionHubDeps;
	#records = new Map<string, SpawnedRecord>();
	#lifecycle = new Set<LifecycleListener>();
	#nextCommandId = 0;
	#sessionRoots = new Map<string, string>();

	constructor(deps: WebSessionHubDeps) {
		this.#deps = deps;
	}

	getSessionRoot(sessionId: string): string | undefined {
		return this.#sessionRoots.get(sessionId);
	}

	onLifecycle(listener: LifecycleListener): void {
		this.#lifecycle.add(listener);
	}

	offLifecycle(listener: LifecycleListener): void {
		this.#lifecycle.delete(listener);
	}

	getSessions(): SessionRegistryEntry[] {
		return this.#deps.registry.getSpawned();
	}

	async spawn(input: WebSpawnInput): Promise<WebSpawnResult> {
		const sessionId = nextSessionId();
		const client = await this.#deps.sessionManager.getOrCreate(sessionId, input.base);
		// Wait for ready event with a deadline.
		await this.#waitForReady(client);

		const record: SpawnedRecord = {
			sessionId,
			rpcClient: client,
			listeners: new Set(),
			rootListener: event => {
				if (event.type === "error") {
					logger.warn("web spawned session error", { sessionId, message: event.message });
					this.#removeRecord(sessionId);
					return;
				}
				for (const listener of record.listeners) listener(event);
			},
			watchActive: false,
		};
		client.onEvent(record.rootListener);
		this.#records.set(sessionId, record);

		this.#deps.registry.registerSpawned({
			sessionId,
			ownedBy: input.ownedBy,
			templateName: input.templateName,
			watchExtensions: input.watchExtensions,
			rpcClient: client,
			metadata: {
				pid: process.pid,
				cwd: input.base.cwd,
				mode: input.mode ?? "rpc",
				startedAt: Date.now(),
				projectName: input.templateName ?? "web",
			},
		});

		if (input.sessionRoot && this.#deps.artifactWatcher) {
			this.#sessionRoots.set(sessionId, input.sessionRoot);
			this.#deps.artifactWatcher.watch(sessionId, input.sessionRoot);
			record.watchActive = true;
		}
		this.#emit({ type: "session_added", sessionId });
		return { sessionId };
	}

	async kill(sessionId: string): Promise<void> {
		const record = this.#records.get(sessionId);
		if (!record) return;
		this.#removeRecord(sessionId);
		await this.#deps.sessionManager.kill(sessionId).catch(error => {
			logger.warn("kill spawned session failed", { sessionId, error: String(error) });
		});
	}

	subscribeEvents(sessionId: string, listener: EventListener): () => void {
		const record = this.#records.get(sessionId);
		if (!record) {
			throw new Error(`Unknown spawned session '${sessionId}'`);
		}
		record.listeners.add(listener);
		return () => {
			record.listeners.delete(listener);
		};
	}

	async send(sessionId: string, command: BridgeRpcCommand): Promise<RpcResponseEvent> {
		const record = this.#records.get(sessionId);
		if (!record) {
			throw new Error(`Spawned session '${sessionId}' is not steerable (external or unknown)`);
		}
		const id = command.id ?? `cmd-${++this.#nextCommandId}`;
		const enriched: BridgeRpcCommand = { ...command, id };
		const { promise, resolve } = Promise.withResolvers<RpcResponseEvent>();
		const off = (): void => {
			record.rpcClient.offEvent(handler);
		};
		const handler = (event: RpcEvent): void => {
			if (event.type !== "response") return;
			off();
			resolve(event);
		};
		record.rpcClient.onEvent(handler);
		try {
			record.rpcClient.send(enriched);
		} catch (error) {
			off();
			throw error;
		}
		return promise;
	}

	stop(): void {
		for (const sessionId of [...this.#records.keys()]) {
			this.#removeRecord(sessionId);
		}
		this.#lifecycle.clear();
	}

	#removeRecord(sessionId: string): void {
		const record = this.#records.get(sessionId);
		if (!record) return;
		this.#records.delete(sessionId);
		record.rpcClient.offEvent(record.rootListener);
		this.#deps.registry.deregister(sessionId);
		if (record.watchActive) {
			this.#deps.artifactWatcher?.unwatch(sessionId);
		}
		this.#sessionRoots.delete(sessionId);
		this.#emit({ type: "session_removed", sessionId });
	}

	async #waitForReady(client: RpcClient, timeoutMs = 30_000): Promise<void> {
		// SessionManager.getOrCreate already starts the client. We assume an
		// already-alive client returns a ready event on first interaction; if
		// not received within timeout, the spawn still proceeds (best-effort).
		if (!client.alive) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const handler = (event: RpcEvent): void => {
			if (event.type === "ready") {
				client.offEvent(handler);
				resolve();
			}
		};
		client.onEvent(handler);
		const t = setTimeout(() => {
			client.offEvent(handler);
			resolve();
		}, timeoutMs);
		if (typeof t === "object" && t !== null && "unref" in t) {
			(t as NodeJS.Timeout).unref();
		}
		await promise;
	}

	#emit(event: LifecycleEvent): void {
		for (const listener of this.#lifecycle) listener(event);
	}
}
