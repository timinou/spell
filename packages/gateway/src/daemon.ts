/**
 * Gateway daemon entry point — Unix socket control plane + service orchestration.
 *
 * Runs as a standalone Bun process. Accepts NDJSON connections on a Unix socket,
 * dispatches to registry and process manager.
 *
 * Usage: bun packages/gateway/src/daemon.ts
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { isEnoent, logger } from "@spell/pi-utils";
import { probeSocket } from "@spell/pi-utils/managed-daemon";
import * as postmortem from "@spell/pi-utils/postmortem";
import { ProcessManager } from "./process-manager";
import {
	type GatewayRequest,
	type GatewayResponse,
	PATHS,
	parseMessage,
	resolveSocketPath,
	serializeMessage,
} from "./protocol";
import { type ProxyServers, startProxy } from "./proxy";
import { GatewayRegistry, GatewayRegistryError } from "./registry";
import { ensureCerts } from "./tls";

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

const socketPath = resolveSocketPath();
const registry = new GatewayRegistry();
const processManager = new ProcessManager();

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: GatewayRequest): Promise<GatewayResponse> {
	const { id } = req;
	try {
		switch (req.type) {
			case "register": {
				const entry = await registry.add(req.config);
				// If managed config is provided, spawn the backend
				if (req.config.managed) {
					try {
						const backend = await processManager.spawn(req.config.alias, req.config.managed);
						if (backend.pid) {
							await registry.updateStatus(req.config.alias, "active", { pid: backend.pid });
						}
					} catch (err) {
						await registry.updateStatus(req.config.alias, "error", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return { id, ok: true, data: entry };
			}

			case "deregister": {
				// Stop managed backend if running
				await processManager.stop(req.alias);
				await registry.remove(req.alias);
				return { id, ok: true };
			}

			case "list": {
				const services = await registry.list();
				return { id, ok: true, data: services };
			}

			case "status": {
				if (req.alias) {
					const entry = await registry.get(req.alias);
					if (!entry) return { id, ok: false, error: `Unknown alias: ${req.alias}`, code: "not_found" };
					const backendState = processManager.getState(req.alias);
					return { id, ok: true, data: { ...entry, backend: backendState } };
				}
				// General daemon status
				const services = await registry.list();
				return {
					id,
					ok: true,
					data: {
						socketPath,
						pid: process.pid,
						serviceCount: services.length,
						uptime: process.uptime(),
					},
				};
			}

			case "cleanup": {
				const removed = await registry.cleanupSession(req.sessionId);
				// Stop managed backends for removed services
				await Promise.allSettled(removed.map(alias => processManager.stop(alias)));
				return { id, ok: true, data: { removed } };
			}

			case "cert_info": {
				const caRoot = await getCaRoot();
				return {
					id,
					ok: true,
					data: {
						certPath: PATHS.cert,
						keyPath: PATHS.key,
						caRoot,
					},
				};
			}

			case "health": {
				return { id, ok: true, data: { status: "healthy", pid: process.pid } };
			}

			default:
				return {
					id,
					ok: false,
					error: `Unknown request type: ${(req as never as Record<string, unknown>).type}`,
					code: "unknown_type",
				};
		}
	} catch (err) {
		if (err instanceof GatewayRegistryError) {
			return { id, ok: false, error: err.message, code: err.code };
		}
		return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// mkcert CA root
// ---------------------------------------------------------------------------

async function getCaRoot(): Promise<string | null> {
	try {
		const mkcert = Bun.which("mkcert");
		if (!mkcert) return null;
		const result = Bun.spawnSync(["mkcert", "-CAROOT"], { stdio: ["ignore", "pipe", "ignore"] });
		return result.stdout.toString().trim() || null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

function handleConnection(conn: net.Socket): void {
	let buffer = "";

	conn.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (;;) {
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx === -1) break;
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);

			const msg = parseMessage(line);
			if (!msg || !("type" in msg) || !("id" in msg)) {
				// Not a valid request, ignore
				continue;
			}

			const req = msg as GatewayRequest;
			handleRequest(req)
				.then(response => {
					if (!conn.destroyed) {
						conn.write(serializeMessage(response));
					}
				})
				.catch(err => {
					if (!conn.destroyed) {
						conn.write(serializeMessage({ id: req.id, ok: false, error: String(err) }));
					}
				});
		}
	});

	conn.on("error", err => {
		logger.debug("[gateway] Client connection error", { error: err.message });
	});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function cleanStaleSocket(): Promise<void> {
	try {
		await fs.access(socketPath);
		// Socket file exists — check if someone is listening
		const alive = await probeSocket(socketPath, 1000);
		if (alive) {
			logger.error("[gateway] Another daemon instance is already running", { socketPath });
			process.exit(1);
		}
		// Stale socket — remove it
		await fs.unlink(socketPath);
		logger.debug("[gateway] Removed stale socket", { socketPath });
	} catch (err) {
		if (!isEnoent(err)) throw err;
		// Socket doesn't exist, nothing to clean
	}
}

async function startDaemon(): Promise<void> {
	await cleanStaleSocket();

	const server = net.createServer(handleConnection);

	server.listen(socketPath, () => {
		logger.debug("[gateway] Daemon started", { socketPath, pid: process.pid });
	});

	server.on("error", err => {
		logger.error("[gateway] Socket server error", { error: err.message });
		process.exit(1);
	});

	// Start HTTPS reverse proxy (optional — control plane works without it)
	let proxy: ProxyServers | null = null;
	try {
		const tls = await ensureCerts();
		proxy = startProxy({ registry, processManager, tls });
		logger.debug("[gateway] HTTPS reverse proxy started");
	} catch (err) {
		logger.warn("[gateway] HTTPS proxy not started (TLS certs may be missing)", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Register postmortem cleanup
	postmortem.register("gateway-daemon", async reason => {
		logger.debug("[gateway] Postmortem cleanup", { reason });
		proxy?.stop();
		server.close();
		await processManager.stopAll();
		try {
			await fs.unlink(socketPath);
		} catch {
			// Best effort
		}
	});

	// Graceful shutdown on signals
	const shutdown = async () => {
		logger.debug("[gateway] Shutting down...");
		proxy?.stop();
		server.close();
		await processManager.stopAll();
		try {
			await fs.unlink(socketPath);
		} catch {
			// Best effort
		}
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

// Run if this is the entry point
startDaemon().catch(err => {
	logger.error("[gateway] Failed to start daemon", { error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});
