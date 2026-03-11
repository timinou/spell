import * as net from "node:net";
import { logger } from "@oh-my-pi/pi-utils";
import type { NiriEvent } from "./types";

/** Callback invoked for each decoded Niri IPC event */
export type NiriEventCallback = (event: NiriEvent) => void;

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_FACTOR = 2;

/**
 * Connects to the Niri IPC socket, subscribes to EventStream, and delivers
 * parsed events via callback. Automatically reconnects on socket close.
 *
 * Lifecycle:
 *   const stream = new NiriEventStream(socketPath, onEvent);
 *   // later…
 *   stream.destroy();
 */
export class NiriEventStream {
	#socketPath: string;
	#onEvent: NiriEventCallback;
	#socket: net.Socket | null = null;
	#destroyed = false;
	#reconnectDelay = RECONNECT_INITIAL_MS;
	#reconnectTimer: NodeJS.Timeout | undefined = undefined;
	// Accumulates partial JSON lines between data chunks
	#buffer = "";

	constructor(socketPath: string, onEvent: NiriEventCallback) {
		this.#socketPath = socketPath;
		this.#onEvent = onEvent;
		this.#connect();
	}

	destroy(): void {
		this.#destroyed = true;
		clearTimeout(this.#reconnectTimer);
		this.#socket?.destroy();
		this.#socket = null;
	}

	#connect(): void {
		if (this.#destroyed) return;

		const socket = net.createConnection(this.#socketPath);
		this.#socket = socket;
		this.#buffer = "";
		let handshakeDone = false;

		socket.on("connect", () => {
			// Subscribe to the event stream
			socket.write('"EventStream"\n');
		});

		socket.on("data", (chunk: Buffer) => {
			this.#buffer += chunk.toString("utf8");
			const lines = this.#buffer.split("\n");
			// Keep the last (possibly incomplete) fragment
			this.#buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					logger.debug("NiriEventStream: unparseable line", { line: trimmed });
					continue;
				}

				// First response is the handshake acknowledgement {"Ok":"Handled"}
				if (!handshakeDone) {
					handshakeDone = true;
					this.#reconnectDelay = RECONNECT_INITIAL_MS;
					logger.debug("NiriEventStream: subscribed");
					continue;
				}

				// Niri wraps events in {"Ok": <event>}
				const event: NiriEvent =
					parsed !== null &&
					typeof parsed === "object" &&
					"Ok" in (parsed as object) &&
					typeof (parsed as { Ok: unknown }).Ok === "object"
						? ((parsed as { Ok: NiriEvent }).Ok as NiriEvent)
						: (parsed as NiriEvent);

				try {
					this.#onEvent(event);
				} catch (err) {
					logger.error("NiriEventStream: event callback threw", { err: String(err) });
				}
			}
		});

		const onClose = () => {
			if (this.#destroyed) return;
			logger.debug("NiriEventStream: socket closed, scheduling reconnect", {
				delay: this.#reconnectDelay,
			});
			this.#reconnectTimer = setTimeout(() => {
				this.#reconnectDelay = Math.min(this.#reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
				this.#connect();
			}, this.#reconnectDelay);
		};

		socket.on("close", onClose);
		socket.on("error", (err: Error) => {
			logger.debug("NiriEventStream: socket error", { err: err.message });
			// error is always followed by close; close handler schedules reconnect
		});
	}
}
