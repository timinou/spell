import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManagedBufferContent } from "@oh-my-pi/pi-coding-agent/tools/managed-code-buffer";

/**
 * Contract: when the underlying `executeCodeBuffer({ command: "edit", … })`
 * call returns `output.status === "failed"` (or "partial") with at least one
 * failed `fileResults[]` entry, `applyManagedBufferContent` MUST throw — and
 * the on-disk file MUST remain unchanged.
 *
 * Regression: prior to the fix the wrapper only inspected the top-level
 * `error: boolean` flag, which the native edit command keeps `false` even when
 * every per-file operation failed. This caused the `write` tool to report
 * "Successfully wrote N bytes" while silently rolling the buffer back, leaving
 * subsequent edits operating on a buffer state that diverges from the agent's
 * mental model.
 */
describe("applyManagedBufferContent", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "managed-buffer-err-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws when the native edit reports a per-file failure (unparseable Rust)", () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn f() -> u32 { 1 }\n";
		writeFileSync(file, original);

		expect(() => applyManagedBufferContent(file, "PLACEHOLDER", { create: true })).toThrow(
			/Managed code buffer update failed/,
		);

		// Disk must be untouched on failure.
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("includes the native per-file error message in the thrown error", () => {
		const file = join(dir, "lib.rs");
		writeFileSync(file, "pub fn f() -> u32 { 1 }\n");

		let caught: Error | undefined;
		try {
			applyManagedBufferContent(file, "PLACEHOLDER", { create: true });
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught?.message).toContain("structurally invalid");
		expect(caught?.message).toContain(file);
	});

	it("does not throw on successful writes (parseable replacement)", () => {
		const file = join(dir, "lib.rs");
		writeFileSync(file, "pub fn f() -> u32 { 1 }\n");
		const replacement = "pub fn f() -> u32 { 42 }\n";

		expect(() => applyManagedBufferContent(file, replacement, { create: true })).not.toThrow();

		expect(readFileSync(file, "utf8")).toBe(replacement);
	});
});
