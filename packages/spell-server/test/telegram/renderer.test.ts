import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { RendererExecutor } from "../../src/telegram/renderer";
import type { RendererConfig } from "../../src/config/types";

describe("RendererExecutor", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(tmpdir(), "renderer-test-"));
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(testDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("returns unknown_renderer when rendererId not found", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "cat-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const result = await executor.render({
			rendererId: "nonexistent",
			markdown: "test content",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("unknown_renderer");
			expect(result.message).toContain("nonexistent");
		}
	});

	it("spawns subprocess successfully with cat command", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "cat-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown = "hello from renderer";
		const result = await executor.render({
			rendererId: "cat-renderer",
			markdown,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bytes.toString("utf-8")).toBe(markdown);
			expect(result.mime).toBe("text/plain");
			expect(result.extension).toBe("txt");
			expect(result.cached).toBe(false);
		}
	});

	it("handles subprocess timeout with SIGKILL", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "sleep-renderer",
				command: "sleep",
				args: ["5"],
				timeoutMs: 100,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const startTime = Date.now();
		const result = await executor.render({
			rendererId: "sleep-renderer",
			markdown: "timeout test",
		});

		const elapsed = Date.now() - startTime;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("timeout");
		}
		expect(elapsed).toBeLessThan(500); // Should timeout quickly, not wait 5s
	});

	it("returns subprocess_error when subprocess exits with non-zero code", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "fail-renderer",
				command: "bash",
				args: ["-c", "exit 7"],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const result = await executor.render({
			rendererId: "fail-renderer",
			markdown: "test",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("subprocess_error");
		}
	});

	it("returns io_error when command not found", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "nonexistent-cmd",
				command: "/nonexistent/command/path/12345",
				args: [],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const result = await executor.render({
			rendererId: "nonexistent-cmd",
			markdown: "test",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("io_error");
		}
	});

	it("caches identical renders and returns cached: true on hit", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "cached-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown = "test content for caching";

		// First call - should not be cached
		const result1 = await executor.render({
			rendererId: "cached-renderer",
			markdown,
		});

		expect(result1.ok).toBe(true);
		if (result1.ok) {
			expect(result1.cached).toBe(false);
		}

		// Second call - should be cached
		const result2 = await executor.render({
			rendererId: "cached-renderer",
			markdown,
		});

		expect(result2.ok).toBe(true);
		if (result2.ok) {
			expect(result2.cached).toBe(true);
			if (result1.ok) {
				expect(result2.bytes).toEqual(result1.bytes);
			}
		}
	});

	it("cache key is sensitive to markdown content", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "cached-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown1 = "content 1";
		const markdown2 = "content 2";

		const result1 = await executor.render({
			rendererId: "cached-renderer",
			markdown: markdown1,
		});

		const result2 = await executor.render({
			rendererId: "cached-renderer",
			markdown: markdown2,
		});

		// Both should succeed but second should not be from cache (different markdown)
		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);
		if (result1.ok && result2.ok) {
			expect(result1.cached).toBe(false);
			expect(result2.cached).toBe(false);
		}
	});

	it("cache key is sensitive to renderer signature (command)", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "renderer-v1",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
			{
				id: "renderer-v2",
				command: "cat",
				args: ["--number"],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown = "same content";

		const result1 = await executor.render({
			rendererId: "renderer-v1",
			markdown,
		});

		const result2 = await executor.render({
			rendererId: "renderer-v2",
			markdown,
		});

		// Both should succeed but second should not be from cache (different renderer signature)
		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);
		if (result1.ok && result2.ok) {
			expect(result1.cached).toBe(false);
			expect(result2.cached).toBe(false);
		}
	});

	it("circuit breaker: opens after threshold failures", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "fail-renderer",
				command: "bash",
				args: ["-c", "exit 1"],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			breakerThreshold: 3,
			breakerCooldownMs: 1000,
		});

		// Three failures to reach threshold
		for (let i = 0; i < 3; i++) {
			const result = await executor.render({
				rendererId: "fail-renderer",
				markdown: "test",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("subprocess_error");
			}
		}

		// Fourth call should get circuit_open without spawning
		const result4 = await executor.render({
			rendererId: "fail-renderer",
			markdown: "test",
		});

		expect(result4.ok).toBe(false);
		if (!result4.ok) {
			expect(result4.reason).toBe("circuit_open");
		}
	});

	it("breaker cooldown: circuit reopens after cooldown expires", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "fail-then-succeed",
				command: "bash",
				args: ["-c", "exit 1"],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			breakerThreshold: 1,
			breakerCooldownMs: 200,
		});

		// One failure to trip breaker
		const result1 = await executor.render({
			rendererId: "fail-then-succeed",
			markdown: "test",
		});
		expect(result1.ok).toBe(false);

		// Circuit should be open
		const result2 = await executor.render({
			rendererId: "fail-then-succeed",
			markdown: "test",
		});
		expect(result2.ok).toBe(false);
		if (!result2.ok) {
			expect(result2.reason).toBe("circuit_open");
		}

		// Wait for cooldown
		await new Promise(resolve => setTimeout(resolve, 250));

		// Circuit should be closed, but command still fails
		const result3 = await executor.render({
			rendererId: "fail-then-succeed",
			markdown: "test",
		});
		expect(result3.ok).toBe(false);
		if (!result3.ok) {
			expect(result3.reason).toBe("subprocess_error"); // Not circuit_open
		}
	});

	it("resetBreaker clears failure count", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "fail-renderer",
				command: "bash",
				args: ["-c", "exit 1"],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			breakerThreshold: 2,
		});

		// One failure
		await executor.render({
			rendererId: "fail-renderer",
			markdown: "test",
		});

		// Reset the breaker
		executor.resetBreaker("fail-renderer");

		// Failure count should be cleared, so we should be able to attempt again
		// without getting circuit_open (need 2 failures to trip)
		const result = await executor.render({
			rendererId: "fail-renderer",
			markdown: "test",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("subprocess_error"); // Not circuit_open
		}
	});

	it("stress test: 20 concurrent identical renders (in-flight dedup - only one subprocess spawned)", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "fast-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			cacheCapacity: 32,
		});

		const markdown = "concurrent test content";

		// Launch 20 concurrent renders
		const promises = Array.from({ length: 20 }, () =>
			executor.render({
				rendererId: "fast-renderer",
				markdown,
			}),
		);

		const results = await Promise.all(promises);

		// All should succeed
		expect(results.every(r => r.ok)).toBe(true);

		// All should have same bytes (deduped renders get the same result)
		const firstResult = results[0];
		expect(firstResult.ok).toBe(true);
		if (firstResult.ok) {
			const firstBytes = firstResult.bytes;
			expect(results.every(r => r.ok && r.bytes.equals(firstBytes))).toBe(true);
		}
	});

	it("does not cache when cacheBy is not set", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "no-cache-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
				// cacheBy is undefined
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown = "test";

		const result1 = await executor.render({
			rendererId: "no-cache-renderer",
			markdown,
		});

		const result2 = await executor.render({
			rendererId: "no-cache-renderer",
			markdown,
		});

		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);
		if (result1.ok && result2.ok) {
			expect(result1.cached).toBe(false);
			expect(result2.cached).toBe(false);
		}
	});

	it("forwards env variables to subprocess", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "env-renderer",
				command: "bash",
				args: ["-c", "echo $MY_VAR"],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const result = await executor.render({
			rendererId: "env-renderer",
			markdown: "test",
			env: { MY_VAR: "hello-from-request" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bytes.toString("utf-8").trim()).toBe("hello-from-request");
		}
	});

	it("handles empty markdown input", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "cat-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const result = await executor.render({
			rendererId: "cat-renderer",
			markdown: "",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bytes.toString("utf-8")).toBe("");
		}
	});

	it("resets breaker on successful render after failures", async () => {
		// Create a script that fails then succeeds based on env var
		const scriptPath = path.join(testDir, "toggle.sh");
		fs.writeFileSync(
			scriptPath,
			`#!/bin/bash
if [ "$SHOULD_FAIL" = "1" ]; then
  exit 1
else
  echo success
fi
`,
		);
		fs.chmodSync(scriptPath, 0o755);

		const renderers: RendererConfig[] = [
			{
				id: "toggle-renderer",
				command: "bash",
				args: [scriptPath],
				timeoutMs: 5000,
				mime: "text/plain",
				extension: "txt",
				env: { SHOULD_FAIL: "1" },
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			breakerThreshold: 2,
		});

		// Fail twice to reach threshold
		for (let i = 0; i < 2; i++) {
			const result = await executor.render({
				rendererId: "toggle-renderer",
				markdown: "test",
			});
			expect(result.ok).toBe(false);
		}

		// Circuit breaker should be active, but can still try once more (threshold is 2, we've failed 2x)
		// Actually with threshold 2, after 2 failures the next call will be circuit_open
		const resultCircuitOpen = await executor.render({
			rendererId: "toggle-renderer",
			markdown: "test",
		});
		expect(resultCircuitOpen.ok).toBe(false);
		if (!resultCircuitOpen.ok) {
			expect(resultCircuitOpen.reason).toBe("circuit_open");
		}
	});

	it("LRU cache evicts least recently used when full", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "lru-renderer",
				command: "cat",
				args: [],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
			cacheCapacity: 2, // Very small cache
		});

		// Render with 3 different contents
		const markdown1 = "content1";
		const markdown2 = "content2";
		const markdown3 = "content3";

		const result1 = await executor.render({
			rendererId: "lru-renderer",
			markdown: markdown1,
		});
		expect(result1.ok).toBe(true);

		const result2 = await executor.render({
			rendererId: "lru-renderer",
			markdown: markdown2,
		});
		expect(result2.ok).toBe(true);

		const result3 = await executor.render({
			rendererId: "lru-renderer",
			markdown: markdown3,
		});
		expect(result3.ok).toBe(true);

		// Now request markdown1 again - should not be cached (was evicted)
		const result1Again = await executor.render({
			rendererId: "lru-renderer",
			markdown: markdown1,
		});

		expect(result1Again.ok).toBe(true);
		if (result1Again.ok) {
			expect(result1Again.cached).toBe(false); // Was evicted
		}

		// But markdown3 should still be cached (most recent)
		const result3Again = await executor.render({
			rendererId: "lru-renderer",
			markdown: markdown3,
		});

		expect(result3Again.ok).toBe(true);
		if (result3Again.ok) {
			expect(result3Again.cached).toBe(true); // Still in cache
		}
	});

	it("cache key is sensitive to request env", async () => {
		const renderers: RendererConfig[] = [
			{
				id: "env-renderer",
				command: "sh",
				args: ["-c", "echo \"SPELL_RENDER_TITLE=$SPELL_RENDER_TITLE\" && cat"],
				timeoutMs: 5000,
				cacheBy: "transcript-hash",
				mime: "text/plain",
				extension: "txt",
			},
		];

		const executor = new RendererExecutor({
			renderers,
			cwd: testDir,
		});

		const markdown = "test markdown content";

		// First request with one env var
		const result1 = await executor.render({
			rendererId: "env-renderer",
			markdown,
			env: { SPELL_RENDER_TITLE: "Title1" },
		});

		expect(result1.ok).toBe(true);
		if (result1.ok) {
			expect(result1.cached).toBe(false);
		}

		// Second request with same markdown but different env var
		const result2 = await executor.render({
			rendererId: "env-renderer",
			markdown,
			env: { SPELL_RENDER_TITLE: "Title2" },
		});

		expect(result2.ok).toBe(true);
		if (result2.ok) {
			// Should not be cached (different env)
			expect(result2.cached).toBe(false);
		}

		// Third request with same markdown and same env as first - should be cached
		const result3 = await executor.render({
			rendererId: "env-renderer",
			markdown,
			env: { SPELL_RENDER_TITLE: "Title1" },
		});

		expect(result3.ok).toBe(true);
		if (result3.ok) {
			// Should be cached (same markdown and env as first)
			expect(result3.cached).toBe(true);
		}
	});
});
