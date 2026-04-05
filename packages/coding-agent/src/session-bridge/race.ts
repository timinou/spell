import { logger } from "@oh-my-pi/pi-utils";
import type { SessionBridgeClient } from "./client";
import type { BlockingEventPayload, EventResponsePayload } from "./types";

export interface RaceResult<T> {
	source: "local" | "remote";
	value: T;
}

type RemoteRaceResult<T> = { outcome: "resolved"; value: T } | { outcome: "cancelled" } | { outcome: "unmapped" };

type BlockingEventRequestPayload = BlockingEventPayload extends infer Payload
	? Payload extends { eventId: string }
		? Omit<Payload, "eventId">
		: never
	: never;

export async function raceWithBridge<T>(
	localPromise: Promise<T>,
	bridge: SessionBridgeClient | undefined,
	payload: BlockingEventRequestPayload,
	mapResponse: (response: EventResponsePayload) => T | undefined,
): Promise<RaceResult<T>> {
	if (!bridge || !bridge.isConnected()) {
		const value = await localPromise;
		return { source: "local", value };
	}

	const remotePromise = bridge.emitBlockingEvent(payload);
	const raced = await Promise.race([
		localPromise.then(value => ({ source: "local" as const, value })),
		remotePromise.then<RemoteRaceResult<T>>(response => {
			if (!response) {
				return { outcome: "cancelled" };
			}

			const value = mapResponse(response);
			if (value === undefined) {
				return { outcome: "unmapped" };
			}

			return { outcome: "resolved", value };
		}),
	]);

	if ("source" in raced) {
		return raced;
	}

	if (raced.outcome === "resolved") {
		return { source: "remote", value: raced.value };
	}

	logger.debug("Session bridge fell back to local resolution", {
		eventKind: payload.kind,
		reason: raced.outcome,
	});
	const value = await localPromise;
	return { source: "local", value };
}
