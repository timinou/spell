import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManagedBufferContent } from "@oh-my-pi/pi-coding-agent/tools/managed-code-buffer";
import * as piNatives from "@oh-my-pi/pi-natives";

type ExecuteCodeBufferOptions = Parameters<typeof piNatives.executeCodeBuffer>[0];
type ExecuteCodeBufferResult = ReturnType<typeof piNatives.executeCodeBuffer>;

const testSession = { getSessionId: () => "test-session" };

describe("applyManagedBufferContent", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "managed-buffer-err-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("leaves no file behind when a missing markdown create is structurally invalid", () => {
		const file = join(dir, "subagent-envelope-v2.md");

		expect(() =>
			applyManagedBufferContent(file, "# broken\u0000markdown\n", {
				create: true,
				session: testSession,
			}),
		).toThrow(/Managed code buffer update failed/);
		expect(existsSync(file)).toBe(false);
	});

	it("restores the exact prior bytes when an existing overwrite is structurally invalid", () => {
		const file = join(dir, "module.ts");
		const original = "export const value = 1;\n";
		writeFileSync(file, original);

		expect(() =>
			applyManagedBufferContent(file, "export const = ;\n", {
				create: false,
				session: testSession,
			}),
		).toThrow(/Managed code buffer update failed/);
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("returns a warning when bytes persist but managed-buffer invalidation fails", () => {
		const file = join(dir, "module.ts");
		const replacement = "export const value = 42;\n";
		writeFileSync(file, "export const value = 1;\n");

		const executeCodeBuffer = piNatives.executeCodeBuffer;
		vi.spyOn(piNatives, "executeCodeBuffer").mockImplementation((options: ExecuteCodeBufferOptions) => {
			if (options.command === "close") {
				return { error: true, output: "close exploded" } satisfies ExecuteCodeBufferResult;
			}
			return executeCodeBuffer(options);
		});

		const result = applyManagedBufferContent(file, replacement, {
			create: false,
			session: testSession,
		});

		expect(readFileSync(file, "utf8")).toBe(replacement);
		expect(result.bufferInvalidationError).toContain("Write persisted to disk");
		expect(result.bufferInvalidationError).toContain(file);
		expect(result.bufferInvalidationError).toContain("close exploded");
	});
});
