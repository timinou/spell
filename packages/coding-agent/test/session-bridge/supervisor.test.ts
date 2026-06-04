import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionBridgeClient } from "../../src/session-bridge/client";

/**
 * Verifies the persistent supervisor: a TUI started BEFORE the control server
 * (or surviving a server restart) must register as soon as the socket appears.
 */
describe("SessionBridgeClient supervisor", () => {
	let dir: string;
	let socketPath: string;
	const clients: SessionBridgeClient[] = [];
	const servers: net.Server[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-supervise-"));
		socketPath = path.join(dir, "server.sock");
	});

	afterEach(async () => {
		for (const c of clients) c.dispose();
		clients.length = 0;
		for (const s of servers) {
			(s as net.Server & { _spellConns?: Set<net.Socket> })._spellConns?.forEach(c => c.destroy());
			await new Promise<void>(r => s.close(() => r()));
		}
		servers.length = 0;
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function startServer(onRegister: (sessionId: string) => void): Promise<net.Server> {
		const received: string[] = [];
		const conns = new Set<net.Socket>();
		const server = net.createServer(socket => {
			conns.add(socket);
			socket.on("close", () => conns.delete(socket));
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					received.push(line);
					try {
						const msg = JSON.parse(line) as { type?: string; sessionId?: string };
						if (msg.type === "register") {
							socket.write(
								`${JSON.stringify({ type: "registered", timestamp: Date.now(), serverVersion: "t", registeredAt: Date.now() })}\n`,
							);
							onRegister(msg.sessionId ?? "");
						}
					} catch {
						// ignore
					}
					nl = buffer.indexOf("\n");
				}
			});
		});
		(server as net.Server & { _spellConns?: Set<net.Socket> })._spellConns = conns;
		servers.push(server);
		// Mirror production SocketServer: remove a stale socket file before listening.
		try {
			await fs.unlink(socketPath);
		} catch {
			// ENOENT on first start
		}
		return new Promise<net.Server>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve(server));
		});
	}

	function makeClient(): SessionBridgeClient {
		const c = new SessionBridgeClient({
			socketPath,
			sessionId: "supervised",
			pid: process.pid,
			cwd: "/tmp",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "x",
		});
		clients.push(c);
		return c;
	}

	it("registers once the server appears after the client started", async () => {
		const client = makeClient();
		// No server yet → first attempt fails, supervisor keeps trying.
		const first = await client.start();
		expect(first).toBe(false);
		expect(client.isConnected()).toBe(false);

		const registered: string[] = [];
		await startServer(id => registered.push(id));

		// Supervisor backoff first step is 500ms; allow margin.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && registered.length === 0) {
			await Bun.sleep(50);
		}
		expect(registered).toContain("supervised");
		expect(client.isConnected()).toBe(true);
	});

	it("re-registers after a server restart", async () => {
		const registered: string[] = [];
		const server = await startServer(id => registered.push(id));
		const client = makeClient();
		expect(await client.start()).toBe(true);
		await Bun.sleep(50);
		expect(registered.length).toBe(1);

		// Restart the server: model a real process death by destroying the live
		// client connection (server.close alone leaves existing sockets open).
		(server as net.Server & { _spellConns?: Set<net.Socket> })._spellConns?.forEach(s => s.destroy());
		await new Promise<void>(r => server.close(() => r()));
		servers.splice(servers.indexOf(server), 1);
		await Bun.sleep(150);
		await startServer(id => registered.push(id));

		const deadline = Date.now() + 4000;
		while (Date.now() < deadline && registered.length < 2) {
			await Bun.sleep(50);
		}
		expect(registered.length).toBeGreaterThanOrEqual(2);
		expect(client.isConnected()).toBe(true);
	});
});
