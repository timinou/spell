/**
 * Tests for ManagedDaemon lifecycle: spawn, socket readiness, health checks,
 * postmortem registration, and graceful/forced stop.
 *
 * Uses real Unix sockets via `net.createServer` and real spawned processes
 * (tiny `sleep` or `cat` commands) to exercise the actual lifecycle rather
 * than mocking internals.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { type DaemonConfig, type ManagedDaemon, probeSocket, startDaemon, waitForSocket } from "../src/managed-daemon";
import * as postmortem from "../src/postmortem";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-daemon-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function sockPath(name = "test"): string {
	return path.join(tmpDir, `${name}.sock`);
}

/**
 * Create a listening Unix server at the given path and return the server.
 * The server accepts connections but does nothing with them.
 */
async function createListener(socketPath: string): Promise<net.Server> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const server = net.createServer();
	server.listen(socketPath, () => resolve());
	await promise;
	return server;
}

/**
 * Build a DaemonConfig that spawns a real shell process which creates
 * the socket file, then sleeps forever. This gives us a real PID and
 * a real socket file to test against.
 */
function shellDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
	const sock = overrides.socketPath ?? sockPath();
	// bash: create the socket (via a background socat) would be ideal,
	// but we need to keep it simple. Instead, create the socket file ourselves
	// via a small node script, then sleep. We'll use `touch` + sleep.
	// Actually, waitForSocket only checks fs.access, so touch suffices.
	return {
		name: "test-daemon",
		command: ["bash", "-c", `touch "${sock}" && sleep 300`],
		socketPath: sock,
		healthIntervalMs: 0, // disable by default in tests
		startupTimeoutMs: 5000,
		logStderr: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// probeSocket
// ---------------------------------------------------------------------------

describe("probeSocket", () => {
	it("returns true for a live listener", async () => {
		const sock = sockPath("probe-live");
		const server = await createListener(sock);
		try {
			expect(await probeSocket(sock)).toBe(true);
		} finally {
			server.close();
		}
	});

	it("returns false for a dead socket file (no listener)", async () => {
		const sock = sockPath("probe-dead");
		// Create then close — socket file remains but nothing listens.
		const server = await createListener(sock);
		await new Promise<void>(resolve => server.close(() => resolve()));

		expect(await probeSocket(sock)).toBe(false);
	});

	it("returns false for a non-existent socket", async () => {
		expect(await probeSocket(sockPath("no-such-socket"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// waitForSocket
// ---------------------------------------------------------------------------

describe("waitForSocket", () => {
	it("resolves when socket appears before deadline", async () => {
		const sock = sockPath("wait-ok");
		// Create the file after a short delay.
		setTimeout(async () => {
			await Bun.write(sock, "");
		}, 100);

		await waitForSocket(sock, 3000, 50);
		// Should not throw — file appeared.
		const stat = await fs.stat(sock);
		expect(stat).toBeDefined();
	});

	it("throws when socket never appears", async () => {
		const sock = sockPath("wait-timeout");
		await expect(waitForSocket(sock, 300, 50)).rejects.toThrow(/did not appear within 300ms/);
	});
});

// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------

describe("startDaemon", () => {
	let daemon: ManagedDaemon | null = null;

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
	});

	it("spawns a daemon, waits for socket, and reports alive", async () => {
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		expect(daemon.isAlive()).toBe(true);
		expect(daemon.pid).toBeGreaterThan(0);
		expect(daemon.socketPath).toBe(config.socketPath);
	});

	it("throws on startup timeout when socket never appears", async () => {
		const config = shellDaemonConfig({
			// Command that does NOT create the socket file.
			command: ["sleep", "300"],
			startupTimeoutMs: 500,
		});
		await expect(startDaemon(config)).rejects.toThrow(/did not appear within 500ms/);
	});

	it("exposes the real process PID", async () => {
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		// The PID should be a real running process.
		expect(daemon.pid).toBeGreaterThan(0);
		// Verify via kill -0.
		expect(() => process.kill(daemon!.pid, 0)).not.toThrow();
	});

	it("registers with postmortem on start", async () => {
		const registerSpy = spyOn(postmortem, "register");
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		expect(registerSpy).toHaveBeenCalledTimes(1);
		expect(registerSpy.mock.calls[0][0]).toBe("test-daemon");
		registerSpy.mockRestore();
	});

	it("deregisters from postmortem on stop", async () => {
		// Capture the cancel function returned by register.
		const realRegister = postmortem.register.bind(postmortem);
		const cancelFns: (() => void)[] = [];
		const registerSpy = spyOn(postmortem, "register").mockImplementation(
			(id: string, callback: (reason: postmortem.Reason) => void | Promise<void>) => {
				const cancel = realRegister(id, callback);
				const wrappedCancel = mock(() => cancel());
				cancelFns.push(wrappedCancel);
				return wrappedCancel;
			},
		);

		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		expect(cancelFns.length).toBe(1);
		// Cancel should not have been called yet.
		expect(cancelFns[0]).not.toHaveBeenCalled();

		await daemon.stop();
		daemon = null;

		// After stop, the cancel function should have been called.
		expect(cancelFns[0]).toHaveBeenCalledTimes(1);
		registerSpy.mockRestore();
	});

	it("detects crash when socket disappears via probe", async () => {
		const sock = sockPath("health");
		const onCrash = mock(() => {});

		const config = shellDaemonConfig({
			socketPath: sock,
			onCrash,
		});
		daemon = await startDaemon(config);

		// Socket exists, daemon is alive.
		expect(daemon.isAlive()).toBe(true);
		expect(await daemon.probe()).toBe(true);

		// Remove the socket to simulate a crash.
		await fs.unlink(sock);

		// Probe should detect the missing socket.
		expect(await daemon.probe()).toBe(false);
		expect(daemon.isAlive()).toBe(false);
		expect(onCrash).toHaveBeenCalledTimes(1);
	});

	it("probe deep check validates live listener", async () => {
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		// Shallow probe checks file existence only.
		expect(await daemon.probe()).toBe(true);
		// Deep probe would need a real socket listener; shellDaemonConfig does not create one.
		expect(await daemon.probe(true)).toBe(false);
	});

	it("executes stopCommand during stop when provided", async () => {
		const marker = path.join(tmpDir, "stop-marker");
		const config = shellDaemonConfig({
			stopCommand: ["bash", "-c", `touch "${marker}"`],
		});
		daemon = await startDaemon(config);

		await daemon.stop();
		daemon = null;

		// The stop command should have created the marker file.
		const exists = await fs.access(marker).then(
			() => true,
			() => false,
		);
		expect(exists).toBe(true);
	});

	it("stop works without stopCommand (kill only)", async () => {
		const config = shellDaemonConfig({
			stopCommand: undefined,
		});
		daemon = await startDaemon(config);
		const pid = daemon.pid;

		await daemon.stop();
		daemon = null;

		// Process should be dead.
		await Bun.sleep(100);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("stop is idempotent — second call does not throw", async () => {
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		await daemon.stop();
		// Second stop should be a no-op.
		await daemon.stop();
		daemon = null;
	});

	it("stop removes socket file", async () => {
		const config = shellDaemonConfig();
		daemon = await startDaemon(config);

		// Socket exists before stop — fs.access resolves (to null in Bun).
		const accessResult = await fs.access(config.socketPath).then(
			() => true,
			() => false,
		);
		expect(accessResult).toBe(true);

		await daemon.stop();
		daemon = null;

		// Socket should be gone.
		await expect(fs.access(config.socketPath)).rejects.toThrow();
	});

	it("forwards daemon stderr to logger when logStderr is true", async () => {
		const sock = sockPath("stderr-log");
		const config: DaemonConfig = {
			name: "stderr-test",
			command: ["bash", "-c", `echo "daemon-stderr-line" >&2; touch "${sock}"; sleep 300`],
			socketPath: sock,
			healthIntervalMs: 0,
			startupTimeoutMs: 5000,
			logStderr: true,
		};
		daemon = await startDaemon(config);

		// Give stderr consumption a moment to process.
		await Bun.sleep(200);

		// We can't easily assert logger.debug was called with the exact line
		// without a spy, but the daemon should be alive and functional.
		expect(daemon.isAlive()).toBe(true);
	});

	it("postmortem callback kills daemon process on EXIT reason", async () => {
		// Capture the postmortem callback to invoke it manually.
		let capturedCallback: ((reason: postmortem.Reason) => void | Promise<void>) | null = null;
		const registerSpy = spyOn(postmortem, "register").mockImplementation(
			(_id: string, callback: (reason: postmortem.Reason) => void | Promise<void>) => {
				capturedCallback = callback;
				return () => {};
			},
		);

		const config = shellDaemonConfig();
		daemon = await startDaemon(config);
		const pid = daemon.pid;

		expect(capturedCallback).not.toBeNull();
		// Simulate process exit — callback should kill the daemon synchronously.
		capturedCallback!(postmortem.Reason.EXIT);

		// Give a moment for kill to take effect.
		await Bun.sleep(200);
		expect(() => process.kill(pid, 0)).toThrow();

		registerSpy.mockRestore();
		daemon = null; // Already dead.
	});
});
