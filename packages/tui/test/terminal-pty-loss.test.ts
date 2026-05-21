import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

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

		process.stdout.emit("error", new Error("EIO"));
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

		process.stdout.emit("error", new Error("EIO"));
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
			process.stdout.emit("error", new Error("EIO"));
		} catch {
			/* process.stdout throws when no error listeners are registered */
		}
		await Bun.sleep(0);

		expect(reasons).toEqual([]);
	});

	it("safeWrite is no-op after onPtyLost", async () => {
		const { terminal, writes } = setupTerminal();
		const beforeCount = writes.length;

		process.stdout.emit("error", new Error("EIO"));
		await Bun.sleep(0);

		terminal.write("should-not-write");
		expect(writes.length).toBe(beforeCount);

		terminal.stop();
	});
});
