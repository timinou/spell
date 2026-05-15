import { describe, expect, it } from "bun:test";
import { WebSessionHub, type ProcessInfoSample } from "../../src/web/session/web-session-hub";
import type { RpcClient, RpcEvent } from "../../src/rpc";

/**
 * Minimal stub of RpcClient — exposes pid + onStderr/onEvent shape that the
 * hub depends on. Uses the current process pid so /proc/<pid>/stat exists.
 */
function makeStubClient(pid: number): RpcClient {
	const eventListeners = new Set<(e: RpcEvent) => void>();
	return {
		alive: true,
		pid,
		onEvent(listener: (e: RpcEvent) => void) {
			eventListeners.add(listener);
			// Auto-fire `ready` so WebSessionHub.#waitForReady resolves immediately.
			queueMicrotask(() => listener({ type: "ready" }));
		},
		offEvent(listener: (e: RpcEvent) => void) {
			eventListeners.delete(listener);
		},
		onStderr(_: (line: string) => void) {
			return () => undefined;
		},
		send() {},
		async kill() {},
	} as unknown as RpcClient;
}

describe("WebSessionHub.onProcessInfo", () => {
	it("emits at least one process_info sample within 6s", async () => {
		const registry = {
			registerSpawned: () => {},
			deregister: () => {},
			getSession: () => undefined,
		} as unknown as ConstructorParameters<typeof WebSessionHub>[0]["registry"];
		const sessionManager = {
			async getOrCreate() {
				return makeStubClient(process.pid);
			},
			async kill() {},
		} as unknown as ConstructorParameters<typeof WebSessionHub>[0]["sessionManager"];

		const hub = new WebSessionHub({ sessionManager, registry });
		const samples: ProcessInfoSample[] = [];
		hub.onProcessInfo(s => samples.push(s));

		const spawnResult = await hub.spawn({
			ownedBy: "test",
			mode: "rpc",
			base: { cwd: process.cwd(), tools: [] },
		});

		// Sampling fires shortly after spawn (100 ms warmup) then every 5 s.
		await Bun.sleep(400);
		await hub.kill(spawnResult.sessionId);

		expect(samples.length).toBeGreaterThanOrEqual(1);
		const first = samples[0]!;
		expect(first.sessionId).toBe(spawnResult.sessionId);
		expect(first.pid).toBe(process.pid);
		expect(first.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(first.ts).toBeGreaterThan(0);
		// rssBytes is positive on Linux (we read our own /proc/self/stat).
		if (process.platform === "linux") {
			expect(first.rssBytes).toBeGreaterThan(0);
		}
	}, 10_000);

	it("stops emitting after the session is killed", async () => {
		const registry = {
			registerSpawned: () => {},
			deregister: () => {},
			getSession: () => undefined,
		} as unknown as ConstructorParameters<typeof WebSessionHub>[0]["registry"];
		const sessionManager = {
			async getOrCreate() {
				return makeStubClient(process.pid);
			},
			async kill() {},
		} as unknown as ConstructorParameters<typeof WebSessionHub>[0]["sessionManager"];

		const hub = new WebSessionHub({ sessionManager, registry });
		const samples: ProcessInfoSample[] = [];
		hub.onProcessInfo(s => samples.push(s));

		const spawnResult = await hub.spawn({
			ownedBy: "test",
			mode: "rpc",
			base: { cwd: process.cwd(), tools: [] },
		});
		await Bun.sleep(300);
		const countAfterFirst = samples.length;
		expect(countAfterFirst).toBeGreaterThanOrEqual(1);

		await hub.kill(spawnResult.sessionId);
		await Bun.sleep(300);
		// After kill, no new samples should arrive (interval cleared).
		expect(samples.length).toBe(countAfterFirst);
	}, 10_000);
});
