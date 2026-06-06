import { describe, expect, it } from "bun:test";
import type * as net from "node:net";
import { SocketSessionRegistry } from "../../src/socket/session-registry";

/**
 * A stand-in for a net.Socket connection. The registry only ever calls
 * `.destroy()` and reads `.destroyed` on the connection it stores, so a tiny
 * fake is sufficient to exercise the reconnect-eviction race.
 */
function fakeSocket(): net.Socket {
	const sock = {
		destroyed: false,
		destroy() {
			(sock as { destroyed: boolean }).destroyed = true;
		},
		write() {
			return true;
		},
	};
	return sock as unknown as net.Socket;
}

const metadata = {
	pid: 1234,
	cwd: "/tmp/p",
	mode: "interactive",
	startedAt: Date.now(),
	projectName: "p",
} as const;

describe("registry reconnect race", () => {
	it("guarded deregister is a no-op when the session re-registered over a new socket", () => {
		const registry = new SocketSessionRegistry();
		const oldSock = fakeSocket();
		const newSock = fakeSocket();

		registry.register("sess", { ...metadata }, oldSock);
		// Fast reconnect: the new socket registers BEFORE the old socket's close
		// is delivered. register() destroys the stale socket.
		registry.register("sess", { ...metadata }, newSock);
		expect(oldSock.destroyed).toBe(true);
		expect(registry.getSession("sess")?.connection).toBe(newSock);

		// The old socket's deferred close fires now. A naive deregister(sessionId)
		// would evict the LIVE entry; the guarded variant must be a no-op.
		registry.deregisterIfConnection("sess", oldSock);
		expect(registry.getSession("sess")?.connection).toBe(newSock);
	});

	it("guarded deregister removes the session when the current socket closes", () => {
		const registry = new SocketSessionRegistry();
		const sock = fakeSocket();
		registry.register("sess", { ...metadata }, sock);

		registry.deregisterIfConnection("sess", sock);
		expect(registry.getSession("sess")).toBeUndefined();
	});

	it("guarded deregister tolerates an already-removed session", () => {
		const registry = new SocketSessionRegistry();
		const sock = fakeSocket();
		// No throw when the session is unknown.
		expect(() => registry.deregisterIfConnection("missing", sock)).not.toThrow();
	});
});
