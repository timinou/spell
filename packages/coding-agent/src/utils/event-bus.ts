import { logger } from "@oh-my-pi/pi-utils";

/** Priority levels for event dispatch. */
export enum Priority {
	/** Armed tool invocations. Always synchronous, never queued. */
	P0 = 0,
	/** User-initiated events (clicks, prompts, commands). Bounded FIFO. */
	P1 = 1,
	/** Agent-initiated events (canvas updates, status). Bounded, coalesce on overflow. */
	P2 = 2,
	/** Background events (heartbeats, silent updates). Bounded, drop-oldest on overflow. */
	P3 = 3,
}

interface QueueEntry {
	channel: string;
	data: unknown;
	priority: Priority;
	/** Optional key for P2 coalescing. Entries with same channel+key are replaced. */
	key?: string;
	timestamp: number;
}

interface SubscribeOptions {
	/** Only receive events at or above this priority level during drain(). Does not affect emit(). */
	minPriority?: Priority;
}

type EventHandler = (data: unknown) => void | Promise<void>;

interface Subscription {
	handler: EventHandler;
	options?: SubscribeOptions;
}

const DEFAULT_BOUNDS = {
	[Priority.P1]: 100,
	[Priority.P2]: 50,
	[Priority.P3]: 20,
} as const;

/**
 * Priority event bus with tiered dispatch.
 *
 * - emit(): Synchronous fast path (P0). Calls all handlers inline. Identical to the
 *   original EventBus behavior. Armed tools use this.
 * - enqueue(): Adds to a priority-ordered bounded queue for async processing.
 *   P2 coalesces (latest per channel+key wins). P3 drops oldest on overflow.
 * - subscribe(): Registers a handler for a channel. Replaces the old on().
 * - drain(): Processes queued events (called from agent loop between turns).
 * - depth(): Returns live queue metrics for the "surface is truth" principle.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<Subscription>>();
	readonly #queue: QueueEntry[] = [];
	readonly #bounds: Record<Priority.P1 | Priority.P2 | Priority.P3, number>;

	constructor(bounds?: Partial<Record<Priority.P1 | Priority.P2 | Priority.P3, number>>) {
		this.#bounds = {
			[Priority.P1]: bounds?.[Priority.P1] ?? DEFAULT_BOUNDS[Priority.P1],
			[Priority.P2]: bounds?.[Priority.P2] ?? DEFAULT_BOUNDS[Priority.P2],
			[Priority.P3]: bounds?.[Priority.P3] ?? DEFAULT_BOUNDS[Priority.P3],
		};
	}

	/**
	 * Synchronous dispatch. Calls all handlers inline.
	 * This is the P0 fast path — armed tools and other latency-critical events use this.
	 */
	emit(channel: string, data: unknown): void {
		const subs = this.#listeners.get(channel);
		if (!subs) return;
		for (const sub of subs) {
			try {
				sub.handler(data);
			} catch (err) {
				logger.error("EventBus emit handler error", { channel, error: String(err) });
			}
		}
	}

	/**
	 * Enqueue an event for async processing via drain().
	 * P1: FIFO, blocks if full (returns false when queue is at capacity).
	 * P2: coalesces on channel+key (latest wins). Drops on overflow.
	 * P3: drops oldest on overflow.
	 */
	enqueue(channel: string, data: unknown, priority: Priority, key?: string): boolean {
		if (priority === Priority.P0) {
			this.emit(channel, data);
			return true;
		}

		const queuePriority = priority as Priority.P1 | Priority.P2 | Priority.P3;
		const bound = this.#bounds[queuePriority];
		const count = this.#countByPriority(queuePriority);

		if (priority === Priority.P2 && key) {
			// Coalesce: replace existing entry with same channel+key
			const idx = this.#queue.findIndex(e => e.priority === Priority.P2 && e.channel === channel && e.key === key);
			if (idx >= 0) {
				this.#queue[idx] = { channel, data, priority, key, timestamp: Date.now() };
				return true;
			}
		}

		if (count >= bound) {
			if (priority === Priority.P3) {
				// Drop oldest P3
				const oldestIdx = this.#queue.findIndex(e => e.priority === Priority.P3);
				if (oldestIdx >= 0) {
					this.#queue.splice(oldestIdx, 1);
				}
			} else if (priority === Priority.P2) {
				// Drop oldest P2
				const oldestIdx = this.#queue.findIndex(e => e.priority === Priority.P2);
				if (oldestIdx >= 0) {
					this.#queue.splice(oldestIdx, 1);
				}
			} else {
				// P1 at capacity — signal backpressure
				return false;
			}
		}

		this.#queue.push({ channel, data, priority, key, timestamp: Date.now() });
		return true;
	}

	/**
	 * Subscribe to a channel. Returns an unsubscribe function.
	 * Handlers receive events from both emit() and drain().
	 */
	subscribe(channel: string, handler: EventHandler, options?: SubscribeOptions): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const sub: Subscription = { handler, options };
		this.#listeners.get(channel)!.add(sub);
		return () => this.#listeners.get(channel)?.delete(sub);
	}

	/** @deprecated Use subscribe() instead. Kept for backward compatibility during migration. */
	on(channel: string, handler: EventHandler): () => void {
		return this.subscribe(channel, handler);
	}

	/**
	 * Process queued events. Called from the agent loop between turns.
	 * Processes in priority order (P1 first, then P2, then P3).
	 * Returns the number of events processed.
	 */
	async drain(maxItems = 50): Promise<number> {
		let processed = 0;

		while (processed < maxItems && this.#queue.length > 0) {
			// Sort by priority (ascending = highest priority first), then by timestamp
			this.#queue.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp);

			const entry = this.#queue.shift()!;
			const subs = this.#listeners.get(entry.channel);
			if (subs) {
				for (const sub of subs) {
					if (sub.options?.minPriority !== undefined && entry.priority > sub.options.minPriority) {
						continue;
					}
					try {
						await sub.handler(entry.data);
					} catch (err) {
						logger.error("EventBus drain handler error", {
							channel: entry.channel,
							priority: entry.priority,
							error: String(err),
						});
					}
				}
			}
			processed++;
		}

		return processed;
	}

	/** Returns live queue depth by priority level. */
	depth(): { p1: number; p2: number; p3: number } {
		return {
			p1: this.#countByPriority(Priority.P1),
			p2: this.#countByPriority(Priority.P2),
			p3: this.#countByPriority(Priority.P3),
		};
	}

	/** Clear all listeners and queued events. */
	clear(): void {
		this.#listeners.clear();
		this.#queue.length = 0;
	}

	#countByPriority(priority: Priority): number {
		let count = 0;
		for (const entry of this.#queue) {
			if (entry.priority === priority) count++;
		}
		return count;
	}
}
