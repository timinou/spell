/**
 * NiriEventStream tests.
 *
 * Contracts:
 *  - After connecting, sends `"EventStream"\n` to the server.
 *  - Skips the {"Ok":"Handled"} handshake — does not emit it as an event.
 *  - Emits one NiriEvent per subsequent JSON line.
 *  - Assembles events split across TCP chunks.
 *  - Unwraps {"Ok": <event>} envelopes produced by some Niri builds.
 *  - Stops firing after destroy(); does not reconnect.
 *  - Skips malformed lines without throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { NiriEventStream } from "../src/ipc";
import type { NiriEvent } from "../src/types";

// ─── Fake Niri socket server ──────────────────────────────────────────────────

class FakeNiriServer {
	readonly socketPath: string;
	#server: net.Server;
	// All sockets that have connected since the server started.
	#sockets: net.Socket[] = [];
	// Data received from clients, concatenated.
	received = "";

	constructor() {
		this.socketPath = path.join(os.tmpdir(), `niri-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
		this.#server = net.createServer(sock => {
			this.#sockets.push(sock);
			sock.on("data", (d: Buffer) => {
				this.received += d.toString("utf8");
			});
			sock.on("close", () => {
				this.#sockets = this.#sockets.filter(s => s !== sock);
			});
		});
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(this.socketPath, resolve);
		});
	}

	/** Broadcast text to all connected clients. */
	send(data: string): void {
		for (const sock of this.#sockets) sock.write(data);
	}

	close(): Promise<void> {
		for (const sock of this.#sockets) sock.destroy();
		return new Promise(resolve => this.#server.close(() => resolve()));
	}

	get connectedCount(): number {
		return this.#sockets.length;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, ms = 500): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`waitFor timed out after ${ms}ms`);
		await Bun.sleep(10);
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NiriEventStream", () => {
	let server: FakeNiriServer;
	let stream: NiriEventStream | null = null;

	beforeEach(async () => {
		server = new FakeNiriServer();
		await server.start();
	});

	afterEach(async () => {
		stream?.destroy();
		stream = null;
		await server.close();
		try {
			fs.unlinkSync(server.socketPath);
		} catch {
			/* already gone */
		}
	});

	it("sends EventStream subscription on connect", async () => {
		stream = new NiriEventStream(server.socketPath, () => {});
		await waitFor(() => server.received.length > 0);
		expect(server.received).toContain('"EventStream"');
	});

	it("does not emit the handshake acknowledgement", async () => {
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		server.send('{"OverviewOpenedOrClosed":{"is_open":true}}\n');

		await waitFor(() => events.length >= 1);

		// Only the actual event, not the handshake
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ OverviewOpenedOrClosed: { is_open: true } });
	});

	it("emits multiple events in arrival order", async () => {
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		server.send('{"OverviewOpenedOrClosed":{"is_open":true}}\n');
		server.send('{"OverviewOpenedOrClosed":{"is_open":false}}\n');

		await waitFor(() => events.length >= 2);

		expect(events[0]).toEqual({ OverviewOpenedOrClosed: { is_open: true } });
		expect(events[1]).toEqual({ OverviewOpenedOrClosed: { is_open: false } });
	});

	it("assembles an event split across two TCP chunks", async () => {
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		await Bun.sleep(10);
		// Split the event JSON at an arbitrary byte boundary
		server.send('{"OverviewOpened');
		await Bun.sleep(10);
		server.send('OrClosed":{"is_open":true}}\n');

		await waitFor(() => events.length >= 1);
		expect(events[0]).toEqual({ OverviewOpenedOrClosed: { is_open: true } });
	});

	it("unwraps Ok-envelope events", async () => {
		// Some Niri builds send subsequent events as {"Ok": <event>}
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		server.send('{"Ok":{"OverviewOpenedOrClosed":{"is_open":true}}}\n');

		await waitFor(() => events.length >= 1);
		expect(events[0]).toEqual({ OverviewOpenedOrClosed: { is_open: true } });
	});

	it("skips malformed lines without throwing", async () => {
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		server.send("not-valid-json\n");
		server.send('{"OverviewOpenedOrClosed":{"is_open":true}}\n');

		await waitFor(() => events.length >= 1);
		expect(events).toHaveLength(1);
	});

	it("stops emitting after destroy()", async () => {
		const events: NiriEvent[] = [];
		stream = new NiriEventStream(server.socketPath, e => events.push(e));
		await waitFor(() => server.connectedCount > 0);

		server.send('{"Ok":"Handled"}\n');
		// Destroy before any events arrive
		stream.destroy();
		stream = null;

		await Bun.sleep(50);
		server.send('{"OverviewOpenedOrClosed":{"is_open":true}}\n');
		await Bun.sleep(50);

		expect(events).toHaveLength(0);
	});
});
