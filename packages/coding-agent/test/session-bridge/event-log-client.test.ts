import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionBridgeClient } from "../../src/session-bridge/client";

interface MiniBridgeServer {
	socketPath: string;
	receivedLines: string[];
	stop: () => Promise<void>;
}

async function startMiniBridge(): Promise<MiniBridgeServer> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-evlog-client-"));
	const socketPath = path.join(tmpDir, "bridge.sock");
	const receivedLines: string[] = [];
	const sockets: net.Socket[] = [];
	const server = net.createServer(socket => {
		sockets.push(socket);
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				receivedLines.push(line);
				// Acknowledge register so client.connect() resolves true
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

describe("SessionBridgeClient emitEventLog", () => {
	let bridge: MiniBridgeServer;

	beforeEach(async () => {
		bridge = await startMiniBridge();
	});

	afterEach(async () => {
		await bridge.stop();
		delete process.env.SPELL_BRIDGE_EVENT_LOG;
	});

	function makeClient(opts: { eventLog?: boolean } = {}): SessionBridgeClient {
		return new SessionBridgeClient({
			socketPath: bridge.socketPath,
			sessionId: "client-evlog",
			pid: process.pid,
			cwd: "/tmp",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "x",
			eventLog: opts.eventLog,
		});
	}

	it("writes one event_log line per emit when opted in via constructor", async () => {
		const client = makeClient({ eventLog: true });
		expect(await client.connect()).toBe(true);
		client.emitEventLog({ kind: "turn_start", ts: 1 });
		client.emitEventLog({ kind: "turn_end", ts: 2 });
		// Allow socket flush
		await Bun.sleep(20);
		const eventLogLines = bridge.receivedLines.filter(line => line.includes('"event_log"'));
		expect(eventLogLines).toHaveLength(2);
		client.dispose();
	});

	it("respects SPELL_BRIDGE_EVENT_LOG=1 env opt-in", async () => {
		process.env.SPELL_BRIDGE_EVENT_LOG = "1";
		const client = makeClient();
		await client.connect();
		client.emitEventLog({ kind: "tool_call", ts: 1, toolName: "bash" });
		await Bun.sleep(20);
		const eventLogLines = bridge.receivedLines.filter(line => line.includes('"event_log"'));
		expect(eventLogLines).toHaveLength(1);
		client.dispose();
	});

	it("is a no-op when neither env nor flag is set", async () => {
		const client = makeClient();
		await client.connect();
		client.emitEventLog({ kind: "turn_start", ts: 1 });
		await Bun.sleep(20);
		const eventLogLines = bridge.receivedLines.filter(line => line.includes('"event_log"'));
		expect(eventLogLines).toHaveLength(0);
		client.dispose();
	});

	it("truncates assistant_text to 256 characters", async () => {
		const client = makeClient({ eventLog: true });
		await client.connect();
		const longText = "a".repeat(500);
		client.emitEventLog({ kind: "assistant_text", ts: 1, text: longText });
		await Bun.sleep(20);
		const line = bridge.receivedLines.find(l => l.includes('"assistant_text"'));
		expect(line).toBeDefined();
		const parsed = JSON.parse(line as string) as { entry: { text?: string } };
		expect(parsed.entry.text?.length).toBe(256);
	});

	it("drops entries with unknown kinds", async () => {
		const client = makeClient({ eventLog: true });
		await client.connect();
		client.emitEventLog({ kind: "garbage" as any, ts: 1 });
		await Bun.sleep(20);
		const eventLogLines = bridge.receivedLines.filter(line => line.includes('"event_log"'));
		expect(eventLogLines).toHaveLength(0);
		client.dispose();
	});
});
