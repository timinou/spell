import { logger } from "@oh-my-pi/pi-utils";
import type { EventChannel, EventMap, EventPayload } from "./typed-event-map";

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

type EventHandler<TData> = (data: TData) => void | Promise<void>;

interface Subscription<TData> {
	handler: EventHandler<TData>;
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
export class EventBus<TEventMap extends EventMap = EventMap> {
	readonly #listeners = new Map<string, Set<Subscription<unknown>>>();
	readonly #queue: QueueEntry[] = [];
	readonly #bounds: Record<Priority.P1 | Priority.P2 | Priority.P3, number>;

	constructor(bounds?: Partial<Record<Priority.P1 | Priority.P2 | Priority.P3, number>>) {
		this.#bounds = {
			[Priority.P1]: bounds?.[Priority.P1] ?? DEFAULT_BOUNDS[Priority.P1],
			[Priority.P2]: bounds?.[Priority.P2] ?? DEFAULT_BOUNDS[Priority.P2],
			[Priority.P3]: bounds?.[Priority.P3] ?? DEFAULT_BOUNDS[Priority.P3],
		};
	}

	emit<TChannel extends EventChannel<TEventMap>>(channel: TChannel, data: EventPayload<TEventMap, TChannel>): void {
		const subs = this.#listeners.get(channel);
		if (!subs) return;
		for (const sub of subs) {
			try {
				(sub.handler as EventHandler<EventPayload<TEventMap, TChannel>>)(data);
			} catch (err) {
				logger.error("EventBus emit handler error", { channel, error: String(err) });
			}
		}
	}

	enqueue<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
		data: EventPayload<TEventMap, TChannel>,
		priority: Priority,
		key?: string,
	): boolean {
		if (priority === Priority.P0) {
			this.emit(channel, data);
			return true;
		}

		const queuePriority = priority as Priority.P1 | Priority.P2 | Priority.P3;
		const bound = this.#bounds[queuePriority];
		const count = this.#countByPriority(queuePriority);

		if (priority === Priority.P2 && key) {
			const idx = this.#queue.findIndex(e => e.priority === Priority.P2 && e.channel === channel && e.key === key);
			if (idx >= 0) {
				this.#queue[idx] = { channel, data, priority, key, timestamp: Date.now() };
				return true;
			}
		}

		if (count >= bound) {
			if (priority === Priority.P3) {
				const oldestIdx = this.#queue.findIndex(e => e.priority === Priority.P3);
				if (oldestIdx >= 0) {
					this.#queue.splice(oldestIdx, 1);
				}
			} else if (priority === Priority.P2) {
				const oldestIdx = this.#queue.findIndex(e => e.priority === Priority.P2);
				if (oldestIdx >= 0) {
					this.#queue.splice(oldestIdx, 1);
				}
			} else {
				return false;
			}
		}

		this.#queue.push({ channel, data, priority, key, timestamp: Date.now() });
		return true;
	}

	subscribe<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
		handler: EventHandler<EventPayload<TEventMap, TChannel>>,
		options?: SubscribeOptions,
	): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const sub: Subscription<unknown> = { handler: handler as EventHandler<unknown>, options };
		this.#listeners.get(channel)!.add(sub);
		return () => this.#listeners.get(channel)?.delete(sub);
	}

	on<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
		handler: EventHandler<EventPayload<TEventMap, TChannel>>,
	): () => void {
		return this.subscribe(channel, handler);
	}

	async drain(maxItems = 50): Promise<number> {
		let processed = 0;

		while (processed < maxItems && this.#queue.length > 0) {
			this.#queue.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp);

			const entry = this.#queue.shift()!;
			const subs = this.#listeners.get(entry.channel);
			if (subs) {
				for (const sub of subs) {
					if (sub.options?.minPriority !== undefined && entry.priority > sub.options.minPriority) {
						continue;
					}
					try {
						await (sub.handler as EventHandler<unknown>)(entry.data);
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

	depth(): { p1: number; p2: number; p3: number } {
		return {
			p1: this.#countByPriority(Priority.P1),
			p2: this.#countByPriority(Priority.P2),
			p3: this.#countByPriority(Priority.P3),
		};
	}

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
