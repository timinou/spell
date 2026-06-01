import { logger } from "@spell/pi-utils";
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
	stderrListeners: Set<(line: string) => void>;
	rootListener: (event: RpcEvent) => void;
	stderrUnsub?: () => void;
	processInfoTimer?: ReturnType<typeof setInterval>;
	lastCpuSample?: { jiffies: number; ts: number };
	startedAtMs: number;
	watchActive: boolean;
}

export interface ProcessInfoSample {
	sessionId: string;
	pid: number;
	rssBytes: number;
	cpuPercent: number;
	uptimeMs: number;
	ts: number;
}

type ProcessInfoListener = (sample: ProcessInfoSample) => void;

const PROCESS_INFO_INTERVAL_MS = 5_000;
const PAGE_SIZE_BYTES = 4096;
const CLOCK_TICKS_PER_SEC = 100;

/** Parse /proc/<pid>/stat for rss + cumulative CPU jiffies. Linux only. */
async function readProcStat(pid: number): Promise<{ rssBytes: number; jiffies: number } | null> {
	try {
		const raw = await Bun.file(`/proc/${pid}/stat`).text();
		// Field 2 (comm) is in parentheses and can contain spaces; everything
		// after the LAST ')' is space-delimited.
		const lastParen = raw.lastIndexOf(")");
		if (lastParen < 0) return null;
		const rest = raw.slice(lastParen + 2).split(" ");
		// rest[0] is field 3 (state). field N is index (N-3) in rest.
		const utime = Number(rest[11]); // field 14
		const stime = Number(rest[12]); // field 15
		const rssPages = Number(rest[21]); // field 24
		if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(rssPages)) return null;
		return { rssBytes: rssPages * PAGE_SIZE_BYTES, jiffies: utime + stime };
	} catch {
		return null;
	}
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
	#processInfo = new Set<ProcessInfoListener>();
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
			stderrListeners: new Set(),
			rootListener: event => {
				if (event.type === "error") {
					logger.warn("web spawned session error", { sessionId, message: event.message });
					this.#removeRecord(sessionId);
					return;
				}
				for (const listener of record.listeners) listener(event);
			},
			startedAtMs: Date.now(),
			watchActive: false,
		};
		client.onEvent(record.rootListener);
		// onStderr / pid are post-Wave-2 additions. Treat as optional so older
		// stubs (and any non-spawning RpcClient impls) keep working.
		if (typeof client.onStderr === "function") {
			record.stderrUnsub = client.onStderr(line => {
				for (const listener of record.stderrListeners) {
					try {
						listener(line);
					} catch (error) {
						logger.debug("hub stderr listener threw", { sessionId, error: String(error) });
					}
				}
			});
		}
		const pid = client.pid;
		if (typeof pid === "number") {
			const tick = (): void => {
				void this.#sampleProcessInfo(record, pid);
			};
			record.processInfoTimer = setInterval(tick, PROCESS_INFO_INTERVAL_MS);
			if (typeof record.processInfoTimer === "object" && record.processInfoTimer && "unref" in record.processInfoTimer) {
				(record.processInfoTimer as NodeJS.Timeout).unref();
			}
			// First sample shortly after spawn to give the UI immediate data.
			setTimeout(tick, 100);
		}
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
		record.stderrUnsub?.();
		if (record.processInfoTimer) clearInterval(record.processInfoTimer);
		this.#deps.registry.deregister(sessionId);
		if (record.watchActive) {
			this.#deps.artifactWatcher?.unwatch(sessionId);
		}
		this.#sessionRoots.delete(sessionId);
		this.#emit({ type: "session_removed", sessionId });
	}

	/** Subscribe to a session's stderr line stream. Returns unsubscribe fn. */
	subscribeStderr(sessionId: string, listener: (line: string) => void): () => void {
		const record = this.#records.get(sessionId);
		if (!record) {
			throw new Error(`Unknown spawned session '${sessionId}'`);
		}
		record.stderrListeners.add(listener);
		return () => {
			record.stderrListeners.delete(listener);
		};
	}

	/** Listen for periodic process telemetry across ALL spawned sessions. */
	onProcessInfo(listener: ProcessInfoListener): () => void {
		this.#processInfo.add(listener);
		return () => {
			this.#processInfo.delete(listener);
		};
	}

	async #sampleProcessInfo(record: SpawnedRecord, pid: number): Promise<void> {
		const stat = await readProcStat(pid);
		const ts = Date.now();
		let cpuPercent = 0;
		if (stat && record.lastCpuSample) {
			const dj = stat.jiffies - record.lastCpuSample.jiffies;
			const dsec = (ts - record.lastCpuSample.ts) / 1000;
			if (dsec > 0) {
				cpuPercent = Math.max(0, (dj / CLOCK_TICKS_PER_SEC / dsec) * 100);
			}
		}
		if (stat) {
			record.lastCpuSample = { jiffies: stat.jiffies, ts };
		}
		const sample: ProcessInfoSample = {
			sessionId: record.sessionId,
			pid,
			rssBytes: stat?.rssBytes ?? 0,
			cpuPercent,
			uptimeMs: ts - record.startedAtMs,
			ts,
		};
		for (const listener of this.#processInfo) {
			try {
				listener(sample);
			} catch (error) {
				logger.debug("process_info listener threw", { sessionId: record.sessionId, error: String(error) });
			}
		}
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
