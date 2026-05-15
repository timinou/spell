export interface SseEvent {
	deltaMs: number;
	data: string;
}

export function replaySse(events: SseEvent[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		async start(controller) {
			for (const event of events) {
				await new Promise(r => setTimeout(r, Math.min(event.deltaMs, 10)));
				controller.enqueue(encoder.encode(event.data));
			}
			controller.close();
		},
	});
}
