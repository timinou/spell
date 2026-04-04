/**
 * Tests for QML daemon reconnect state buffering.
 *
 * Contracts:
 * 1. When QmlProcess connects to an existing daemon socket, the `state` event
 *    that the C++ daemon sends immediately on connection is buffered in
 *    #pendingReconnectState, available via takeReconnectState().
 * 2. takeReconnectState() returns the event exactly once (clears on take).
 * 3. QmlBridge.reconnect() uses the buffered state event instead of racing
 *    against waitFor(state) — correctly restores the windows map.
 * 4. ensure() returns 'existing' when connecting to a live daemon socket
 *    and 'new' when spawning.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

// Socket/process tests need generous timeouts due to backoff delays and event loop congestion.
setDefaultTimeout(30_000);

import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { QmlProcess } from "../src/qml-process";

describe("QmlProcess - reconnect state buffering", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-test-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	/** Spin up a fake socket server that sends a `state` event on connection. */
	async function startFakeDaemon(
		windows: Array<{ id: string; path: string; state: string }> = [],
	): Promise<net.Server> {
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		const srv = net.createServer(socket => {
			// Send state snapshot immediately, simulating C++ daemon reconnect callback.
			const stateEvent = `${JSON.stringify({ type: "state", windows })}\n`;
			socket.write(stateEvent);
		});
		srv.listen(sockPath, resolve);
		await ready;
		return srv;
	}

	it("takeReconnectState() returns null before any connection", () => {
		const proc = new QmlProcess();
		expect(proc.takeReconnectState()).toBeNull();
	});

	it("buffers the state event that arrives immediately on socket connect", async () => {
		const windows = [{ id: "life-ui", path: "/tmp/game.qml", state: "ready" }];
		server = await startFakeDaemon(windows);

		// Override the socket path resolution for this test.
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			const kind = await proc.ensure();
			// The data event fires in the next I/O cycle — yield to let it deliver.
			await Bun.sleep(20);

			expect(kind).toBe("existing");
			const buffered = proc.takeReconnectState();
			expect(buffered).not.toBeNull();
			expect(buffered?.type).toBe("state");
			if (buffered?.type === "state") {
				expect(buffered.windows).toHaveLength(1);
				expect(buffered.windows[0].id).toBe("life-ui");
			}
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});

	it("takeReconnectState() clears the buffer on first call", async () => {
		server = await startFakeDaemon([{ id: "w1", path: "/tmp/w1.qml", state: "ready" }]);

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			await proc.ensure();
			// Yield one I/O cycle to let the data event deliver.
			await Bun.sleep(20);

			const first = proc.takeReconnectState();
			expect(first).not.toBeNull();
			const second = proc.takeReconnectState();
			expect(second).toBeNull();
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});

	it("ensure() returns 'new' when there is no existing socket to connect to", async () => {
		// No server — socket doesn't exist.
		// We need to prevent it from actually spawning a binary, so mock the binary check.
		// QmlProcess.ensure() will try #connectSocket (fail) then #spawnDaemon.
		// #spawnDaemon checks isBridgeAvailable() and throws if binary is absent.
		// So we expect an error (not 'new') in the no-binary case.
		// The contract is: if connect succeeds → 'existing'; if daemon spawned → 'new'.
		// We test 'new' via the spawnDaemon path separately (needs binary), so this
		// test just confirms the error path when no socket and no binary.
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath; // Points at non-existent socket.

		const proc = new QmlProcess({ binaryPath: "/nonexistent/spell-qml-bridge" });
		try {
			await expect(proc.ensure()).rejects.toThrow();
		} finally {
			QmlProcess.socketPath = origSocketPath;
		}
	});

	it("already-connected proc returns 'existing' on repeated ensure() calls", async () => {
		server = await startFakeDaemon([]);

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			const first = await proc.ensure();
			const second = await proc.ensure();

			expect(first).toBe("existing");
			expect(second).toBe("existing");
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});
});

describe("QmlProcess - multi-client isolation", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-multi-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("second client connection does not disconnect the first", async () => {
		// Fake daemon that tracks connected sockets and sends per-client state.
		const connectedSockets: net.Socket[] = [];
		const { promise: twoConnected, resolve: resolveTwoConnected } = Promise.withResolvers<void>();

		server = net.createServer(socket => {
			connectedSockets.push(socket);
			// Each client gets an empty state event (no windows owned yet).
			socket.write(`${JSON.stringify({ type: "state", windows: [] })}\n`);
			if (connectedSockets.length === 2) resolveTwoConnected();
		});
		await new Promise<void>(r => server!.listen(sockPath, r));

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc1 = new QmlProcess();
		const proc2 = new QmlProcess();
		try {
			await proc1.ensure();
			await proc2.ensure();
			await twoConnected;

			// Both clients should be connected — server tracks two sockets.
			expect(connectedSockets).toHaveLength(2);

			// First client must still be alive (not disconnected by second connect).
			expect(connectedSockets[0].destroyed).toBe(false);
			expect(connectedSockets[1].destroyed).toBe(false);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc1.dispose();
			await proc2.dispose();
		}
	});

	it("each client receives only its own state on connect", async () => {
		// Daemon sends a different state to each client based on connection order.
		let connectionCount = 0;
		server = net.createServer(socket => {
			const clientIndex = connectionCount++;
			// First client owns window-A, second owns window-B.
			const ownedWindows =
				clientIndex === 0
					? [{ id: "window-A", path: "/tmp/a.qml", state: "ready" }]
					: [{ id: "window-B", path: "/tmp/b.qml", state: "ready" }];
			socket.write(`${JSON.stringify({ type: "state", windows: ownedWindows })}\n`);
		});
		await new Promise<void>(r => server!.listen(sockPath, r));

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc1 = new QmlProcess();
		const proc2 = new QmlProcess();
		try {
			await proc1.ensure();
			await proc2.ensure();
			await Bun.sleep(30); // let state events deliver

			const state1 = proc1.takeReconnectState();
			const state2 = proc2.takeReconnectState();

			expect(state1?.type).toBe("state");
			expect(state2?.type).toBe("state");
			if (state1?.type === "state") {
				expect(state1.windows.map(w => w.id)).toEqual(["window-A"]);
			}
			if (state2?.type === "state") {
				expect(state2.windows.map(w => w.id)).toEqual(["window-B"]);
			}
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc1.dispose();
			await proc2.dispose();
		}
	});
});

describe("QmlBridge - reconnect restores window state", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qmlbridge-test-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reconnect() populates windows map from daemon state without racing", async () => {
		const existingWindows = [
			{ id: "game-ui", path: "/tmp/game.qml", state: "ready" },
			{ id: "tools-ui", path: "/tmp/tools.qml", state: "ready" },
		];

		// Fake daemon: sends state immediately on connection, then stays open.
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			// Simulate C++ daemon's immediate state snapshot on reconnect.
			const stateEvent = `${JSON.stringify({ type: "state", windows: existingWindows })}\n`;
			socket.write(stateEvent);
		});
		server.listen(sockPath, resolve);
		await ready;

		const { QmlBridge } = await import("../src/qml-bridge");

		// Override socket path for the bridge's underlying QmlProcess.
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			// Before reconnect, no windows known.
			expect(bridge.listWindows()).toHaveLength(0);

			await bridge.reconnect();

			// After reconnect, windows are restored from daemon state.
			const windows = bridge.listWindows();
			expect(windows).toHaveLength(2);
			expect(windows.map(w => w.id).sort()).toEqual(["game-ui", "tools-ui"]);
			expect(windows[0].state).toBe("ready");
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});

	it("reconnect() handles empty window list gracefully", async () => {
		// Daemon with no open windows.
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			socket.write(`${JSON.stringify({ type: "state", windows: [] })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const { QmlBridge } = await import("../src/qml-bridge");
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			await bridge.reconnect();
			expect(bridge.listWindows()).toHaveLength(0);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});
});

describe("QmlProcess - socket_disconnected event", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-disconnect-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("dispatches socket_disconnected event when server closes unexpectedly", async () => {
		// Start a fake daemon that we can shut down.
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		const connectedSockets: net.Socket[] = [];
		server = net.createServer(socket => {
			connectedSockets.push(socket);
			socket.setKeepAlive(false);
			socket.write(`${JSON.stringify({ type: "state", windows: [] })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			await proc.ensure();
			await Bun.sleep(20);

			// Listen for the socket_disconnected event.
			const { promise: disconnectEvent, resolve: gotEvent } = Promise.withResolvers<boolean>();
			proc.addListener(event => {
				if (event.type === "socket_disconnected") {
					gotEvent(true);
				}
			});

			// Destroy the server-side sockets to trigger unexpected close.
			for (const sock of connectedSockets) {
				sock.end();
				sock.destroy();
			}
			server!.close();

			// Wait generously — socket close can be delayed under event loop congestion.
			const result = await Promise.race([disconnectEvent, Bun.sleep(10_000).then(() => false)]);
			expect(result).toBe(true);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});

	it("concurrent ensure() calls share a single connection", async () => {
		let connectionCount = 0;
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			connectionCount++;
			socket.write(`${JSON.stringify({ type: "state", windows: [] })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			// Fire 5 concurrent ensure() calls.
			const results = await Promise.all([proc.ensure(), proc.ensure(), proc.ensure(), proc.ensure(), proc.ensure()]);

			// All should return 'existing' and exactly one connection made.
			for (const r of results) expect(r).toBe("existing");
			expect(connectionCount).toBe(1);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});
});

describe("QmlProcess - heartbeat", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-heartbeat-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("heartbeat events are received and update lastDataReceived", async () => {
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		let clientSocket: net.Socket | null = null;
		server = net.createServer(socket => {
			clientSocket = socket;
			socket.write(`${JSON.stringify({ type: "state", windows: [] })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			await proc.ensure();
			await Bun.sleep(20);

			const beforeHeartbeat = proc.lastDataReceived;
			await Bun.sleep(50);

			// Send a heartbeat from the fake daemon.
			clientSocket!.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
			await Bun.sleep(20);

			// lastDataReceived should have been updated.
			expect(proc.lastDataReceived).toBeGreaterThan(beforeHeartbeat);

			// Heartbeat should be dispatched to listeners.
			const { promise: heartbeatPromise, resolve: gotHeartbeat } = Promise.withResolvers<boolean>();
			proc.addListener(event => {
				if (event.type === "heartbeat") gotHeartbeat(true);
			});
			clientSocket!.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
			const received = await Promise.race([heartbeatPromise, Bun.sleep(1000).then(() => false)]);
			expect(received).toBe(true);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});

	it("heartbeat events are not pushed to QmlBridge window event queues", async () => {
		// Fake daemon with one window.
		let clientSocket: net.Socket | null = null;
		const existingWindows = [{ id: "test-win", path: "/tmp/test.qml", state: "ready" }];
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			clientSocket = socket;
			socket.write(`${JSON.stringify({ type: "state", windows: existingWindows })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const { QmlBridge } = await import("../src/qml-bridge");
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			await bridge.reconnect();
			const win = bridge.getWindow("test-win");
			expect(win).toBeDefined();
			const eventsBefore = win!.events.length;

			// Send heartbeat from daemon.
			clientSocket!.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
			await Bun.sleep(30);

			// Window event queue should be unchanged.
			expect(win!.events.length).toBe(eventsBefore);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});
});

describe("QmlBridge - socket_disconnected handling", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-bridge-disconnect-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("socket_disconnected does not mark windows as closed", async () => {
		let clientSocket: net.Socket | null = null;
		const existingWindows = [{ id: "survive-win", path: "/tmp/s.qml", state: "ready" }];
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			clientSocket = socket;
			socket.write(`${JSON.stringify({ type: "state", windows: existingWindows })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const { QmlBridge } = await import("../src/qml-bridge");
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			await bridge.reconnect();
			const win = bridge.getWindow("survive-win");
			expect(win).toBeDefined();
			expect(win!.state).toBe("ready");

			// Destroy the client socket to trigger disconnect.
			clientSocket!.destroy();
			await Bun.sleep(100);

			// Window should still be 'ready', NOT 'closed'.
			expect(win!.state).toBe("ready");
			// Disconnect event should be in the window's event queue.
			const disconnectEvents = win!.events.filter(e => e.name === "socket_disconnected");
			expect(disconnectEvents.length).toBeGreaterThan(0);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});
});

describe("QmlBridge - orphaned windows in state snapshot", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-orphan-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reconnect restores orphaned windows from daemon state", async () => {
		// Simulate a daemon that reports one orphaned window and one owned window.
		const windows = [
			{ id: "orphan-win", path: "/tmp/orphan.qml", state: "ready", orphaned: true },
			{ id: "owned-win", path: "/tmp/owned.qml", state: "ready" },
		];
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			socket.write(`${JSON.stringify({ type: "state", windows })}\n`);
		});
		server.listen(sockPath, resolve);
		await ready;

		const { QmlBridge } = await import("../src/qml-bridge");
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			await bridge.reconnect();

			// Both windows should be restored.
			const windowList = bridge.listWindows();
			expect(windowList).toHaveLength(2);
			expect(windowList.map(w => w.id).sort()).toEqual(["orphan-win", "owned-win"]);
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});
});

describe("QmlProcess - auto-reconnect success", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-autoreconnect-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("auto-reconnect re-establishes connection after server-side socket close", async () => {
		const connectedSockets: net.Socket[] = [];
		const { promise: firstConnect, resolve: resolveFirst } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			connectedSockets.push(socket);
			socket.write(
				`${JSON.stringify({ type: "state", windows: [{ id: "w1", path: "/tmp/w1.qml", state: "ready" }] })}\n`,
			);
			if (connectedSockets.length === 1) resolveFirst();
		});
		await new Promise<void>(r => server!.listen(sockPath, r));

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess();
		try {
			await proc.ensure();
			await firstConnect;
			await Bun.sleep(20);

			// Kill the first server and destroy all sockets.
			for (const sock of connectedSockets) sock.destroy();
			server!.close();
			server = null;
			connectedSockets.length = 0;

			// Start a new fake daemon on the same path.
			const { promise: secondConnect, resolve: resolveSecond } = Promise.withResolvers<void>();
			server = net.createServer(socket => {
				connectedSockets.push(socket);
				socket.write(
					`${JSON.stringify({ type: "state", windows: [{ id: "w2", path: "/tmp/w2.qml", state: "ready" }] })}\n`,
				);
				resolveSecond();
			});
			await new Promise<void>(r => server!.listen(sockPath, r));

			// Wait for auto-reconnect to connect to the new server.
			await secondConnect;
			await Bun.sleep(30);

			expect(proc.isDaemon).toBe(true);
			const state = proc.takeReconnectState();
			expect(state).not.toBeNull();
			if (state?.type === "state") {
				expect(state.windows[0].id).toBe("w2");
			}
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});
});

describe("QmlProcess - stale detection", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-stale-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("stale detection reconnects without dispatching socket_disconnected", async () => {
		let connectionCount = 0;
		server = net.createServer(socket => {
			connectionCount++;
			const windows =
				connectionCount === 1
					? [{ id: "old", path: "/tmp/old.qml", state: "ready" }]
					: [{ id: "new", path: "/tmp/new.qml", state: "ready" }];
			socket.write(`${JSON.stringify({ type: "state", windows })}\n`);
		});
		await new Promise<void>(r => server!.listen(sockPath, r));

		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		// Use a very short heartbeat timeout so the test doesn't wait 90s.
		const proc = new QmlProcess({ heartbeatTimeoutMs: 100 });
		try {
			await proc.ensure();
			await Bun.sleep(20); // let state event deliver

			// Consume first reconnect state so it doesn't confuse assertions.
			proc.takeReconnectState();

			// Track socket_disconnected events — none should fire.
			let disconnectFired = false;
			proc.addListener(event => {
				if (event.type === "socket_disconnected") disconnectFired = true;
			});

			// Wait for heartbeat timeout to elapse.
			await Bun.sleep(150);

			// ensure() should detect stale socket and reconnect via #doEnsure.
			const result = await proc.ensure();
			await Bun.sleep(30); // let close handler fire asynchronously

			expect(result).toBe("existing");
			expect(disconnectFired).toBe(false);
			expect(connectionCount).toBe(2);

			// New state from second connection should be available.
			const state = proc.takeReconnectState();
			expect(state).not.toBeNull();
			if (state?.type === "state") {
				expect(state.windows[0].id).toBe("new");
			}
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await proc.dispose();
		}
	});
});

describe("QmlBridge - full disconnect-reconnect-resume cycle", () => {
	let tmpDir: string;
	let sockPath: string;
	let server: net.Server | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-fullcycle-"));
		sockPath = path.join(tmpDir, "bridge.sock");
	});

	afterEach(async () => {
		if (server) {
			server.close();
			server = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("windows survive disconnect and events resume after reconnect", async () => {
		const connectedSockets: net.Socket[] = [];
		const { promise: firstConnect, resolve: resolveFirst } = Promise.withResolvers<void>();
		server = net.createServer(socket => {
			connectedSockets.push(socket);
			// Report one window in daemon state.
			socket.write(
				`${JSON.stringify({ type: "state", windows: [{ id: "persist-win", path: "/tmp/p.qml", state: "ready" }] })}\n`,
			);
			if (connectedSockets.length === 1) resolveFirst();
		});
		await new Promise<void>(r => server!.listen(sockPath, r));

		const { QmlBridge } = await import("../src/qml-bridge");
		const origSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const bridge = new QmlBridge();
		try {
			await bridge.reconnect();
			await firstConnect;
			expect(bridge.listWindows()).toHaveLength(1);
			expect(bridge.getWindow("persist-win")!.state).toBe("ready");

			// Kill the server and destroy all sockets (simulating daemon crash).
			for (const sock of connectedSockets) sock.destroy();
			server!.close();
			server = null;
			connectedSockets.length = 0;

			// Brief pause to let disconnect event propagate.
			await Bun.sleep(50);

			// Window should survive disconnect — NOT marked closed.
			expect(bridge.getWindow("persist-win")!.state).toBe("ready");

			// Start a new daemon that reports the same window plus sends a custom event.
			const { promise: secondConnect, resolve: resolveSecond } = Promise.withResolvers<void>();
			server = net.createServer(socket => {
				connectedSockets.push(socket);
				socket.write(
					`${JSON.stringify({ type: "state", windows: [{ id: "persist-win", path: "/tmp/p.qml", state: "ready" }] })}\n`,
				);
				// Send a custom event after a brief delay.
				setTimeout(() => {
					socket.write(
						`${JSON.stringify({ type: "event", id: "persist-win", name: "post-reconnect", payload: { value: 42 } })}\n`,
					);
				}, 50);
				resolveSecond();
			});
			await new Promise<void>(r => server!.listen(sockPath, r));

			// Wait for auto-reconnect to establish new connection.
			await secondConnect;
			await Bun.sleep(150); // let event deliver

			// Window should still be tracked and event should have arrived.
			const win = bridge.getWindow("persist-win")!;
			expect(win.state).toBe("ready");
			const postReconnectEvents = win.events.filter(e => e.name === "post-reconnect");
			expect(postReconnectEvents.length).toBeGreaterThan(0);
			expect(postReconnectEvents[0].payload).toEqual({ value: 42 });
		} finally {
			QmlProcess.socketPath = origSocketPath;
			await bridge.dispose();
		}
	});
});
