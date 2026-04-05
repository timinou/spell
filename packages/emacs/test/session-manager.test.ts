import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { EmacsSession } from "../src/daemon";
import { EmacsSessionManager } from "../src/session-manager";
import type { CodeWarmupResult } from "../src/tool";

function makeSession(name: string, alive: boolean = true): EmacsSession {
	let currentAlive = alive;
	return {
		socketPath: `/tmp/${name}.sock`,
		isAlive: () => currentAlive,
		stop: async () => {
			currentAlive = false;
		},
	};
}

function ready(session: EmacsSession): CodeWarmupResult {
	return {
		status: "ready",
		version: "30.2",
		session,
	};
}

function startupError(message: string = "socket timeout"): CodeWarmupResult {
	return {
		status: "error",
		error: message,
		version: "30.2",
		session: null,
	};
}

function unavailable(error: string = "Emacs not found"): CodeWarmupResult {
	return {
		status: "unavailable",
		error,
		session: null,
	};
}

describe("EmacsSessionManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns an injected live session without starting a new daemon", async () => {
		let starts = 0;
		const injected = makeSession("injected");
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				return ready(makeSession("started"));
			},
		});
		manager.setSession(injected);

		expect(await manager.getSession()).toBe(injected);
		expect(starts).toBe(0);
	});

	it("restarts lazily when the cached session is dead", async () => {
		let starts = 0;
		const replacement = makeSession("replacement");
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				return ready(replacement);
			},
		});
		manager.setSession(makeSession("dead", false));

		expect(await manager.getSession()).toBe(replacement);
		expect(await manager.getSession()).toBe(replacement);
		expect(starts).toBe(1);
	});

	it("coalesces concurrent callers into one startup attempt", async () => {
		let starts = 0;
		const session = makeSession("coalesced");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				started.resolve();
				await release.promise;
				return ready(session);
			},
		});

		const first = manager.getSession();
		const second = manager.getSession();
		const third = manager.getSession();

		await started.promise;
		expect(starts).toBe(1);
		release.resolve();

		const [firstSession, secondSession, thirdSession] = await Promise.all([first, second, third]);
		expect(firstSession).toBe(session);
		expect(secondSession).toBe(session);
		expect(thirdSession).toBe(session);
	});

	it("retries immediately while failures stay below the circuit-breaker threshold", async () => {
		const session = makeSession("ready-after-errors");
		const results = [startupError("first"), startupError("second"), ready(session)];
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				const next = results[starts];
				starts += 1;
				if (!next) throw new Error("Unexpected extra start attempt");
				return next;
			},
		});

		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBe(session);
		expect(starts).toBe(3);
	});

	it("opens a cooldown after three consecutive startup failures", async () => {
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				return startupError(`failure-${starts}`);
			},
		});

		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(starts).toBe(3);
	});

	it("retries after the cooldown window expires", async () => {
		const session = makeSession("after-cooldown");
		const results = [startupError("first"), startupError("second"), startupError("third"), ready(session)];
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				const next = results[starts];
				starts += 1;
				if (!next) throw new Error("Unexpected extra start attempt");
				return next;
			},
		});

		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		vi.advanceTimersByTime(60_000);
		expect(await manager.getSession()).toBe(session);
		expect(starts).toBe(4);
	});

	it("resets the failure counter after a successful restart", async () => {
		const firstSession = makeSession("first-success");
		const secondSession = makeSession("second-success");
		const results = [
			startupError("first"),
			startupError("second"),
			ready(firstSession),
			startupError("third"),
			ready(secondSession),
		];
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				const next = results[starts];
				starts += 1;
				if (!next) throw new Error("Unexpected extra start attempt");
				return next;
			},
		});

		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBe(firstSession);
		firstSession.stop();
		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBe(secondSession);
		expect(starts).toBe(5);
	});

	it("treats externally observed unavailable warmup results as permanently unavailable", async () => {
		let starts = 0;
		const manager = new EmacsSessionManager({
			startSession: async () => {
				starts += 1;
				return ready(makeSession("unexpected-start"));
			},
		});
		manager.recordWarmupResult(unavailable("Emacs not found in PATH"));

		expect(await manager.getSession()).toBeNull();
		expect(await manager.getSession()).toBeNull();
		expect(starts).toBe(0);
	});
});
