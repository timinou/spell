import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@spell/pi-tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function ioError(code: string, message?: string): Error & { code: string } {
	const err = new Error(message ?? code) as Error & { code: string };
	err.code = code;
	return err;
}

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal pty-loss detection", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	function setupTerminal() {
		const writes: string[] = [];
		const reasons: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);

		return { terminal, writes, reasons };
	}

	it("fires onLost when stdout emits error", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		process.stdout.emit("error", ioError("EIO"));
		await Bun.sleep(0);

		expect(reasons).toEqual(["stdout-error"]);
		terminal.stop();
	});

	it("fires onLost when stdin emits end", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		process.stdin.emit("end");
		await Bun.sleep(0);

		expect(reasons).toEqual(["stdin-end"]);
		terminal.stop();
	});

	it("fires onLost when stdin emits close", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		process.stdin.emit("close");
		await Bun.sleep(0);

		expect(reasons).toEqual(["stdin-close"]);
		terminal.stop();
	});

	it("liveness probe sets #dead when stdout not writable", () => {
		vi.useFakeTimers();
		const { terminal, writes } = setupTerminal();

		// Complete initial OSC 11 + DA1 cycle so the poll timer is the only query source
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const original = Object.getOwnPropertyDescriptor(process.stdout, "writable");
		Object.defineProperty(process.stdout, "writable", { value: false, configurable: true });

		vi.advanceTimersByTime(2000);

		// After liveness probe fires, safeWrite should be a no-op
		const beforeWrite = writes.length;
		terminal.write("should-not-write");
		expect(writes.length).toBe(beforeWrite);

		if (original) {
			Object.defineProperty(process.stdout, "writable", original);
		} else {
			delete (process.stdout as { writable?: unknown }).writable;
		}
		terminal.stop();
	});

	it("is idempotent: multiple events fire callback once", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		process.stdout.emit("error", ioError("EIO"));
		process.stdin.emit("end");
		await Bun.sleep(0);

		expect(reasons).toEqual(["stdout-error"]);
		terminal.stop();
	});

	it("stop() prevents callback firing", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));
		terminal.stop();

		try {
			process.stdout.emit("error", ioError("EIO"));
		} catch {
			/* process.stdout throws when no error listeners are registered */
		}
		await Bun.sleep(0);

		expect(reasons).toEqual([]);
	});

	// Regression: a synchronous throw in a stdin `'data'` listener is re-emitted
	// as `'error'` on the stream. Before this gate, those bubbled into
	// #onPtyLost("stdin-error") and exited the session cleanly with no crash
	// report (this is exactly how the BUG-391 markDirge TypeError manifested).
	it("ignores non-fatal stdin errors (TypeError) and rethrows uncaught", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		const caught: unknown[] = [];
		const handler = (err: unknown) => caught.push(err);
		// Suppress the test runner's uncaughtException policy for this assertion
		// window — our handler is the ONLY listener so we can read the routed err.
		const prior = process.listeners("uncaughtException");
		for (const l of prior) process.off("uncaughtException", l as never);
		process.on("uncaughtException", handler);
		try {
			const err = new TypeError("this.markDirty is not a function");
			process.stdin.emit("error", err);
			await Bun.sleep(0);

			expect(reasons).toEqual([]);
			expect(caught).toHaveLength(1);
			expect(caught[0]).toBe(err);
		} finally {
			process.off("uncaughtException", handler);
			for (const l of prior) process.on("uncaughtException", l as never);
			terminal.stop();
		}
	});

	it("ignores non-fatal stdout errors (no code) and rethrows uncaught", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		const caught: unknown[] = [];
		const handler = (err: unknown) => caught.push(err);
		const prior = process.listeners("uncaughtException");
		for (const l of prior) process.off("uncaughtException", l as never);
		process.on("uncaughtException", handler);
		try {
			const err = new Error("some downstream bug, not IO");
			process.stdout.emit("error", err);
			await Bun.sleep(0);

			expect(reasons).toEqual([]);
			expect(caught).toHaveLength(1);
			expect(caught[0]).toBe(err);
		} finally {
			process.off("uncaughtException", handler);
			for (const l of prior) process.on("uncaughtException", l as never);
			terminal.stop();
		}
	});

	it("treats stdin EBADF / EPIPE as pty-loss", async () => {
		const { terminal, reasons } = setupTerminal();
		terminal.onLost(reason => reasons.push(reason));

		process.stdin.emit("error", ioError("EBADF"));
		await Bun.sleep(0);

		expect(reasons).toEqual(["stdin-error"]);
		terminal.stop();
	});

	it("safeWrite is no-op after onPtyLost", async () => {
		const { terminal, writes } = setupTerminal();
		const beforeCount = writes.length;

		process.stdout.emit("error", ioError("EIO"));
		await Bun.sleep(0);

		terminal.write("should-not-write");
		expect(writes.length).toBe(beforeCount);

		terminal.stop();
	});
});
