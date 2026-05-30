/**
 * NAPI bridge integrity tests.
 *
 * The TS layer is a transport. These tests assert the contract between
 * JS callers and the Rust kernel: every public NAPI surface is callable
 * and produces expected shapes. Behavior assertions are kernel-driven —
 * we test passthrough, not parsing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	executeCodePath,
	getRegisteredExtensions,
	parseCodePath,
	renderCodePath,
} from "@spell/pi-natives";

describe("NAPI bridge integrity", () => {
	let tmpDir: string;
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "napi-bridge-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("getRegisteredExtensions returns a non-empty list of strings", () => {
		const exts = getRegisteredExtensions();
		expect(Array.isArray(exts)).toBe(true);
		expect(exts.length).toBeGreaterThan(0);
		for (const ext of exts) expect(typeof ext).toBe("string");
	});

	test("parseCodePath valid input returns truthy AST", () => {
		const ast = parseCodePath("foo.ts");
		expect(ast).toBeTruthy();
	});

	test("parseCodePath invalid input does not throw", () => {
		// Bracket-range smell: [80-130] is documented as ambiguous; kernel must respond, not crash
		expect(() => parseCodePath("foo.ts[80-130]")).not.toThrow();
	});

	test("renderCodePath round-trips parse output", () => {
		const ast = parseCodePath("src/foo.ts:80-130");
		const rendered = renderCodePath(ast);
		expect(typeof rendered).toBe("string");
		expect(rendered).toContain("foo.ts");
	});

	test("executeCodePath get on tempfile returns chunk envelope (done flag)", async () => {
		const filePath = path.join(tmpDir, "hello.txt");
		await fs.writeFile(filePath, "hello world\n");
		const chunks = await executeCodePath({ command: "get", target: filePath });
		// NAPI layer test: assert envelope shape only. Content extraction (and the
		// no-results diagnostic) lives in the FindTool/GetTool layer, not the bridge.
		expect(Array.isArray(chunks)).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.some(c => c.done === true)).toBe(true);
	});

	test("executeCodePath get with non-existent path returns chunks (empty or diagnostic)", async () => {
		const missingPath = path.join(tmpDir, "nope-xyzpdq.txt");
		const chunks = await executeCodePath({ command: "get", target: missingPath });
		// Bridge contract: returns a chunk envelope without crashing. The 'missing'
		// signal (empty nodes vs explicit diagnostic) is interpreted by the tool layer.
		expect(Array.isArray(chunks)).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
	});

	test("executeCodePath manage status returns kernel snapshot", async () => {
		const chunks = await executeCodePath({ command: "manage", manage: "status", target: "" });
		expect(Array.isArray(chunks)).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
	});

	test("abortSignal cancellation does not crash", async () => {
		const filePath = path.join(tmpDir, "a.txt");
		await fs.writeFile(filePath, "x\n");
		const ctl = new AbortController();
		ctl.abort();
		// The kernel may either reject or return empty chunks; assert it doesn't crash the process
		try {
			await executeCodePath({ command: "get", target: filePath, abortSignal: ctl.signal });
		} catch (e) {
			// Aborted error is acceptable
			expect(e).toBeDefined();
		}
		// Test passes by reaching this point without unhandled crash
		expect(true).toBe(true);
	});
});
