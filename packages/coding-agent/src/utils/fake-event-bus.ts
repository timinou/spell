import { EventBus, type Priority } from "./event-bus";
import type { EventChannel, EventMap, EventPayload } from "./typed-event-map";

export interface RecordedEvent<TChannel extends string = string, TPayload = unknown> {
	channel: TChannel;
	data: TPayload;
}

export interface RecordedQueueEvent<TChannel extends string = string, TPayload = unknown>
	extends RecordedEvent<TChannel, TPayload> {
	priority: Priority;
	key?: string;
}

export class FakeEventBus<TEventMap extends EventMap = EventMap> extends EventBus<TEventMap> {
	readonly emitted: RecordedEvent[] = [];
	readonly enqueued: RecordedQueueEvent[] = [];

	override emit<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
		data: EventPayload<TEventMap, TChannel>,
	): void {
		this.emitted.push({ channel, data });
		super.emit(channel, data);
	}

	override enqueue<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
		data: EventPayload<TEventMap, TChannel>,
		priority: Priority,
		key?: string,
	): boolean {
		this.enqueued.push({ channel, data, priority, key });
		return super.enqueue(channel, data, priority, key);
	}

	clearRecords(): void {
		this.emitted.length = 0;
		this.enqueued.length = 0;
	}

	emittedFor<TChannel extends EventChannel<TEventMap>>(channel: TChannel): Array<EventPayload<TEventMap, TChannel>> {
		return this.emitted
			.filter(event => event.channel === channel)
			.map(event => event.data as EventPayload<TEventMap, TChannel>);
	}

	enqueuedFor<TChannel extends EventChannel<TEventMap>>(channel: TChannel): Array<EventPayload<TEventMap, TChannel>> {
		return this.enqueued
			.filter(event => event.channel === channel)
			.map(event => event.data as EventPayload<TEventMap, TChannel>);
	}

	lastEmitted<TChannel extends EventChannel<TEventMap>>(
		channel: TChannel,
	): EventPayload<TEventMap, TChannel> | undefined {
		const event = [...this.emitted].reverse().find(entry => entry.channel === channel);
		return event?.data as EventPayload<TEventMap, TChannel> | undefined;
	}
}
