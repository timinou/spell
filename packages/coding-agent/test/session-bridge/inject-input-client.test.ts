import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionBridgeClient } from "../../src/session-bridge/client";

interface MiniBridgeServer {
	socketPath: string;
	receivedLines: string[];
	/** Push a raw server→client message to the most recent connection. */
	push: (obj: unknown) => void;
	stop: () => Promise<void>;
}

async function startMiniBridge(): Promise<MiniBridgeServer> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-inject-client-"));
	const socketPath = path.join(tmpDir, "bridge.sock");
	const receivedLines: string[] = [];
	const sockets: net.Socket[] = [];
	let latest: net.Socket | undefined;
	const server = net.createServer(socket => {
		sockets.push(socket);
		latest = socket;
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				receivedLines.push(line);
				try {
					const msg = JSON.parse(line) as { type?: string };
					if (msg.type === "register") {
						socket.write(
							`${JSON.stringify({
								type: "registered",
								timestamp: Date.now(),
								serverVersion: "0.0.0-test",
								registeredAt: Date.now(),
							})}\n`,
						);
					}
				} catch {
					// ignore
				}
				nl = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	return {
		socketPath,
		receivedLines,
		push(obj: unknown) {
			latest?.write(`${JSON.stringify(obj)}\n`);
		},
		async stop() {
			for (const s of sockets) s.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			try {
				await fs.unlink(socketPath);
			} catch {
				// best-effort
			}
		},
	};
}

describe("SessionBridgeClient onInjectInput", () => {
	let bridge: MiniBridgeServer;

	beforeEach(async () => {
		bridge = await startMiniBridge();
	});

	afterEach(async () => {
		await bridge.stop();
	});

	function makeClient(): SessionBridgeClient {
		return new SessionBridgeClient({
			socketPath: bridge.socketPath,
			sessionId: "client-inject",
			pid: process.pid,
			cwd: "/tmp",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "x",
		});
	}

	async function waitForAck(timeoutMs = 1000): Promise<{ injectId: string; accepted: boolean; reason?: string }> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const line = bridge.receivedLines.find(l => l.includes('"inject_ack"'));
			if (line) return JSON.parse(line) as { injectId: string; accepted: boolean; reason?: string };
			await Bun.sleep(10);
		}
		throw new Error("timed out waiting for inject_ack");
	}

	it("invokes the handler and acks accepted with deliverAs forwarded", async () => {
		const client = makeClient();
		expect(await client.connect()).toBe(true);
		const seen: Array<{ text: string; deliverAs: string }> = [];
		client.onInjectInput(async ({ text, deliverAs }) => {
			seen.push({ text, deliverAs });
			return { accepted: true };
		});

		bridge.push({ type: "inject_input", timestamp: Date.now(), injectId: "i1", text: "do the thing", deliverAs: "steer" });

		const ack = await waitForAck();
		expect(ack.injectId).toBe("i1");
		expect(ack.accepted).toBe(true);
		expect(seen).toEqual([{ text: "do the thing", deliverAs: "steer" }]);
		client.dispose();
	});

	it("acks not-accepted with no_handler when none registered", async () => {
		const client = makeClient();
		await client.connect();
		bridge.push({ type: "inject_input", timestamp: Date.now(), injectId: "i2", text: "hi", deliverAs: "auto" });
		const ack = await waitForAck();
		expect(ack.injectId).toBe("i2");
		expect(ack.accepted).toBe(false);
		expect(ack.reason).toBe("no_handler");
		client.dispose();
	});

	it("acks not-accepted with the error reason when the handler throws", async () => {
		const client = makeClient();
		await client.connect();
		client.onInjectInput(async () => {
			throw new Error("bash_running");
		});
		bridge.push({ type: "inject_input", timestamp: Date.now(), injectId: "i3", text: "x", deliverAs: "auto" });
		const ack = await waitForAck();
		expect(ack.accepted).toBe(false);
		expect(ack.reason).toBe("bash_running");
		client.dispose();
	});
});
