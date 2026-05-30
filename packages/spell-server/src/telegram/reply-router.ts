import { isEnoent, logger } from "@spell/pi-utils";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface PendingReply {
	chatId: number;
	sessionId: string;
	eventId: string;
	eventKind: string;
	sessionTitle?: string;
	sentAt: number;
	stale: boolean; // marked true when a new event for the same sessionId fires
}

export interface ReplyRouterOpts {
	persistencePath: string; // ~/.spell/telegram-reply-map.json
	ttlMs: number;
	cleanupIntervalMs?: number; // default 5 * 60_000
}

/**
 * Routes Telegram replies back to pending blocking events.
 * Maintains a mapping of Telegram messageId -> PendingReply with TTL eviction
 * and persistence to JSON.
 */
export class ReplyRouter {
	#map = new Map<number, PendingReply>();
	#opts: ReplyRouterOpts;
	#cleanupInterval: NodeJS.Timeout | null = null;
	#persistPromise: Promise<void> = Promise.resolve();

	constructor(opts: ReplyRouterOpts) {
		this.#opts = {
			...opts,
			cleanupIntervalMs: opts.cleanupIntervalMs ?? 5 * 60_000,
		};

		// Start periodic cleanup
		this.#cleanupInterval = setInterval(
			() => {
				void this.evictExpired().catch(error => {
					logger.warn("Reply router cleanup failed", { error: String(error) });
				});
			},
			this.#opts.cleanupIntervalMs,
		);
	}

	/**
	 * Load persisted mappings from disk and drop expired entries.
	 */
	async load(): Promise<void> {
		try {
			const filePath = this.#opts.persistencePath;
			const content = await Bun.file(filePath).text();
			const parsed = JSON.parse(content) as Record<string, PendingReply>;
			const now = Date.now();

			this.#map.clear();
			for (const [keyStr, entry] of Object.entries(parsed)) {
				const messageId = parseInt(keyStr, 10);
				if (!Number.isFinite(messageId)) {
					continue;
				}

				// Drop expired entries
				if (now - entry.sentAt > this.#opts.ttlMs) {
					continue;
				}

				this.#map.set(messageId, entry);
			}
		} catch (error) {
			if (isEnoent(error)) {
				this.#map.clear();
				return;
			}
			logger.warn("Failed to load reply router state", { error: String(error) });
			this.#map.clear();
		}
	}

	/**
	 * Register a sent message so a Telegram reply can route back.
	 */
	async register(messageId: number, entry: Omit<PendingReply, "sentAt" | "stale">): Promise<void> {
		const pendingReply: PendingReply = {
			...entry,
			sentAt: Date.now(),
			stale: false,
		};
		this.#map.set(messageId, pendingReply);
		await this.#enqueuePersist();
	}

	/**
	 * Look up by Telegram messageId.
	 */
	async lookup(messageId: number): Promise<PendingReply | undefined> {
		return this.#map.get(messageId);
	}

	/**
	 * Mark prior mappings for the same sessionId as stale
	 * (called when registry.setBlockingEvent supersedes a prior event).
	 */
	async supersede(sessionId: string): Promise<void> {
		for (const [, entry] of this.#map) {
			if (entry.sessionId === sessionId) {
				entry.stale = true;
			}
		}
		await this.#enqueuePersist();
	}

	/**
	 * Manual TTL eviction (called periodically + on boot).
	 */
	async evictExpired(): Promise<{ evicted: number }> {
		const now = Date.now();
		let evicted = 0;

		for (const [messageId, entry] of this.#map) {
			if (now - entry.sentAt > this.#opts.ttlMs) {
				this.#map.delete(messageId);
				evicted++;
			}
		}

		if (evicted > 0) {
			await this.#enqueuePersist();
		}

		return { evicted };
	}

	/**
	 * Stop periodic cleanup.
	 */
	dispose(): void {
		if (this.#cleanupInterval) {
			clearInterval(this.#cleanupInterval);
			this.#cleanupInterval = null;
		}
	}

	#enqueuePersist(): Promise<void> {
		this.#persistPromise = this.#persistPromise.then(() => this.#persist()).catch(error => {
			logger.error("Reply router persist failed", { error: String(error) });
		});
		return this.#persistPromise;
	}

	async #persist(): Promise<void> {
		try {
			const filePath = this.#opts.persistencePath;
			const dirPath = path.dirname(filePath);

			// Ensure directory exists
			await fs.mkdir(dirPath, { recursive: true });

			// Convert map to object for JSON serialization
			const obj: Record<string, PendingReply> = {};
			for (const [messageId, entry] of this.#map) {
				obj[String(messageId)] = entry;
			}

			const json = JSON.stringify(obj, null, 2);
			await Bun.write(filePath, json);
		} catch (error) {
			logger.warn("Failed to persist reply router state", {
				path: this.#opts.persistencePath,
				error: String(error),
			});
			throw error;
		}
	}
}
