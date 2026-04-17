import { describe, expect, it } from "bun:test";
import type { PythonKernelExecutor } from "@oh-my-pi/pi-coding-agent/ipy/executor";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/ipy/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/ipy/kernel";

class FakeKernel implements PythonKernelExecutor {
	constructor(
		private readonly result: KernelExecuteResult,
		private readonly onExecute: (options?: KernelExecuteOptions) => Promise<void> | void,
	) {}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}
}

describe("executePythonWithKernel low-spill policy", () => {
	it("spills once output crosses the low line threshold", async () => {
		const lines = Array.from({ length: 80 }, (_, index) => `line${index + 1}`).join("\n");
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => options?.onChunk?.(lines),
		);

		const result = await executePythonWithKernel(kernel, "print('hi')", {
			artifactPath: "/tmp/python-low-spill.txt",
			artifactUri: "artifact://test/main/python/0.txt",
		});

		expect(result.truncated).toBe(true);
		expect(result.artifactUri).toBe("artifact://test/main/python/0.txt");
		expect(result.output).toContain("line80");
		expect(result.output).toContain("line31");
		expect(result.output).not.toContain("line30");
	});

	it("keeps the larger failure residue after spill", async () => {
		const lines = Array.from({ length: 140 }, (_, index) => `line${index + 1}`).join("\n");
		const kernel = new FakeKernel(
			{ status: "error", cancelled: false, timedOut: false, stdinRequested: false },
			options => options?.onChunk?.(lines),
		);

		const result = await executePythonWithKernel(kernel, "raise SystemExit(1)", {
			artifactPath: "/tmp/python-failure-spill.txt",
			artifactUri: "artifact://test/main/python/1.txt",
		});

		expect(result.exitCode).toBe(1);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("line140");
		expect(result.output).toContain("line21");
		expect(result.output).not.toContain("line20");
	});
});
