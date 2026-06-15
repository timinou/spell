import { describe, expect, it } from "bun:test";
import type { SubprocessToolEvent } from "../../src/task/subprocess-tool-registry";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
// Side-effect import registers the bash + run handlers.
import { gatherSubprocessExecutions } from "../../src/task/subprocess-execution-handlers";

describe("subprocess execution handlers — bash", () => {
	it("registers the bash handler", () => {
		expect(subprocessToolRegistry.hasHandler("bash")).toBe(true);
		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData).toBeDefined();
		expect(handler?.shouldTerminate).toBeUndefined();
	});

	it("extracts command and exit code for successful bash execution", () => {
		const event: SubprocessToolEvent = { toolName: "bash", toolCallId: "c1", args: { command: "bun test" }, isError: false };
		expect(subprocessToolRegistry.getHandler("bash")?.extractData?.(event)).toEqual({
			command: "bun test",
			exitCode: 0,
		});
	});

	it("extracts command and exit code for failed bash execution", () => {
		const event: SubprocessToolEvent = { toolName: "bash", toolCallId: "c1", args: { command: "bun test" }, isError: true };
		expect(subprocessToolRegistry.getHandler("bash")?.extractData?.(event)).toEqual({
			command: "bun test",
			exitCode: 1,
		});
	});

	it("extracts real exit code and cwd from bash tool details", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "c1",
			args: { command: "bun test" },
			result: { content: [{ type: "text", text: "Command exited with code 7" }], details: { exitCode: 7, cwd: "/tmp/worktree" } },
			isError: true,
		};
		expect(subprocessToolRegistry.getHandler("bash")?.extractData?.(event)).toEqual({
			command: "bun test",
			exitCode: 7,
			cwd: "/tmp/worktree",
		});
	});

	it("falls back to parsing the rendered error when details are absent", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "c1",
			args: { command: "bun test" },
			result: { content: [{ type: "text", text: "stderr\n\nCommand exited with code 23" }] },
			isError: true,
		};
		expect(subprocessToolRegistry.getHandler("bash")?.extractData?.(event)).toEqual({
			command: "bun test",
			exitCode: 23,
		});
	});

	it("returns undefined when command is missing, non-string, or empty", () => {
		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.({ toolName: "bash", toolCallId: "c1", args: {} })).toBeUndefined();
		expect(handler?.extractData?.({ toolName: "bash", toolCallId: "c1", args: { command: 123 } })).toBeUndefined();
		expect(handler?.extractData?.({ toolName: "bash", toolCallId: "c1", args: { command: "" } })).toBeUndefined();
		expect(handler?.extractData?.({ toolName: "bash", toolCallId: "c1" })).toBeUndefined();
	});
});

describe("subprocess execution handlers — run", () => {
	it("registers the run handler", () => {
		expect(subprocessToolRegistry.hasHandler("run")).toBe(true);
	});

	it("reconstructs the command from argv and reads exit code + cwd", () => {
		const event: SubprocessToolEvent = {
			toolName: "run",
			toolCallId: "c1",
			args: { verb: "mix", args: { args: ["test", "test/x_test.exs"] } },
			result: {
				content: [{ type: "text", text: "run mix" }],
				details: { argv: ["mix", "test", "test/x_test.exs"], exitCode: 0, cwd: "/repo/packages/djinn" },
			},
			isError: false,
		};
		expect(subprocessToolRegistry.getHandler("run")?.extractData?.(event)).toEqual({
			command: "mix test test/x_test.exs",
			exitCode: 0,
			cwd: "/repo/packages/djinn",
		});
	});

	it("defaults exit code from isError when details omit it", () => {
		const event: SubprocessToolEvent = {
			toolName: "run",
			toolCallId: "c1",
			result: { content: [], details: { argv: ["cargo", "test"] } },
			isError: true,
		};
		expect(subprocessToolRegistry.getHandler("run")?.extractData?.(event)).toEqual({
			command: "cargo test",
			exitCode: 1,
		});
	});

	it("returns undefined when argv is missing, empty, or non-string", () => {
		const handler = subprocessToolRegistry.getHandler("run");
		expect(handler?.extractData?.({ toolName: "run", toolCallId: "c1", result: { content: [], details: {} } })).toBeUndefined();
		expect(
			handler?.extractData?.({ toolName: "run", toolCallId: "c1", result: { content: [], details: { argv: [] } } }),
		).toBeUndefined();
		expect(
			handler?.extractData?.({ toolName: "run", toolCallId: "c1", result: { content: [], details: { argv: ["x", 2] } } }),
		).toBeUndefined();
	});
});

describe("gatherSubprocessExecutions", () => {
	it("merges bash and run evidence into one log", () => {
		const merged = gatherSubprocessExecutions({
			bash: [{ command: "bun test", exitCode: 0, cwd: "/a" }],
			run: [{ command: "mix test", exitCode: 0, cwd: "/b" }],
			report_finding: [{ irrelevant: true }],
		});
		expect(merged).toEqual([
			{ command: "bun test", exitCode: 0, cwd: "/a" },
			{ command: "mix test", exitCode: 0, cwd: "/b" },
		]);
	});

	it("returns an empty log for undefined or gate-irrelevant data", () => {
		expect(gatherSubprocessExecutions(undefined)).toEqual([]);
		expect(gatherSubprocessExecutions({ submit_result: [{ status: "success" }] })).toEqual([]);
	});
});
