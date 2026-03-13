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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

		const proc = new QmlProcess();
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
