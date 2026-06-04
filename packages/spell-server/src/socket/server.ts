import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import type { SocketSessionRegistry } from "./session-registry";
import {
	isEventLogEntry,
	isSocketClientMessage,
	type RegisteredSocketServerMessage,
	type RegisterSocketClientMessage,
} from "./types";

const SOCKET_CLEANUP_INTERVAL_MS = 60_000;
const SERVER_VERSION = process.env.npm_package_version ?? "0.1.0";

export class SocketServer {
	#server: net.Server | null = null;
	#registry: SocketSessionRegistry;
	#socketPath: string;
	#cleanupInterval: Timer | undefined;

	constructor(socketPath: string, registry: SocketSessionRegistry) {
		this.#socketPath = socketPath;
		this.#registry = registry;
	}

	async start(): Promise<void> {
		if (this.#server) {
			throw new Error("SocketServer is already started");
		}

		await this.#removeSocketFile();
		await fs.mkdir(path.dirname(this.#socketPath), { recursive: true });

		const server = net.createServer(socket => {
			this.#handleConnection(socket);
		});

		const listenDeferred = Promise.withResolvers<void>();
		server.once("error", listenDeferred.reject);
		server.listen(this.#socketPath, () => {
			server.off("error", listenDeferred.reject);
			listenDeferred.resolve();
		});
		await listenDeferred.promise;

		this.#server = server;
		this.#cleanupInterval = setInterval(() => {
			this.#registry.cleanupStale();
		}, SOCKET_CLEANUP_INTERVAL_MS);
		if (this.#cleanupInterval && "unref" in this.#cleanupInterval) {
			(this.#cleanupInterval as NodeJS.Timeout).unref();
		}
	}

	async stop(): Promise<void> {
		if (this.#cleanupInterval) {
			clearInterval(this.#cleanupInterval);
			this.#cleanupInterval = undefined;
		}

		const server = this.#server;
		this.#server = null;
		if (server) {
			for (const entry of this.#registry.getActive()) {
				entry.connection?.destroy();
			}
			const closeDeferred = Promise.withResolvers<void>();
			server.close(error => {
				if (error) {
					closeDeferred.reject(error);
					return;
				}
				closeDeferred.resolve();
			});
			await closeDeferred.promise;
		}

		await this.#removeSocketFile();
	}

	#handleConnection(socket: net.Socket): void {
		let buffer = "";
		let sessionId: string | undefined;
		let closed = false;

		const cleanup = () => {
			if (closed) {
				return;
			}
			closed = true;
			if (sessionId) {
				this.#registry.deregister(sessionId);
			}
		};

		socket.on("data", chunk => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line) {
					const nextSessionId = this.#handleLine(socket, sessionId, line);
					if (nextSessionId) {
						sessionId = nextSessionId;
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});

		socket.on("close", cleanup);
		socket.on("error", error => {
			logger.warn("Socket client connection failed", { error: String(error), sessionId });
			cleanup();
		});
	}

	#handleLine(socket: net.Socket, sessionId: string | undefined, line: string): string | undefined {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			logger.warn("Skipping invalid socket JSON line", { error: String(error), line });
			return sessionId;
		}

		if (!isSocketClientMessage(parsed)) {
			logger.warn("Skipping invalid socket client message", { line });
			return sessionId;
		}

		switch (parsed.type) {
			case "register":
				this.#handleRegister(socket, parsed);
				return parsed.sessionId;
			case "deregister":
				if (sessionId) {
					this.#registry.deregister(sessionId);
				}
				return undefined;
			case "blocking_event":
				if (sessionId) {
					this.#registry.setBlockingEvent(sessionId, parsed.payload);
				}
				return sessionId;
			case "heartbeat":
				if (sessionId) {
					this.#registry.updateHeartbeat(sessionId);
				}
				return sessionId;
			case "event_resolved":
				if (sessionId) {
					this.#registry.clearBlockingEvent(sessionId);
				}
				return sessionId;
			case "inject_ack":
				this.#registry.resolveInject(parsed.injectId, parsed.accepted, parsed.reason);
				return sessionId;
			case "event_log":
				if (sessionId && isEventLogEntry(parsed.entry)) {
					this.#registry.appendEventLog(sessionId, parsed.entry);
				} else if (sessionId) {
					logger.warn("Skipping malformed event_log entry", { sessionId });
				}
				return sessionId;
			default:
				return sessionId;
		}
	}

	#handleRegister(socket: net.Socket, message: RegisterSocketClientMessage): void {
		this.#registry.register(
			message.sessionId,
			{
				pid: message.pid,
				cwd: message.cwd,
				mode: message.mode,
				startedAt: message.startedAt,
				projectName: message.projectName,
				sessionRoot: message.sessionRoot,
			},
			socket,
		);

		const response: RegisteredSocketServerMessage = {
			type: "registered",
			serverVersion: SERVER_VERSION,
			registeredAt: Date.now(),
			timestamp: Date.now(),
		};
		socket.write(`${JSON.stringify(response)}\n`);
	}

	async #removeSocketFile(): Promise<void> {
		try {
			await fs.unlink(this.#socketPath);
		} catch (error) {
			const unlinkError = error as NodeJS.ErrnoException;
			if (unlinkError.code !== "ENOENT") {
				throw error;
			}
		}
	}
}
