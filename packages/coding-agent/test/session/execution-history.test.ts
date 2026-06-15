import { describe, expect, it } from "bun:test";
import { extractExecutionHistory } from "../../src/session/execution-history";
import { matchesGateCmd } from "../../src/task/gate-verification";

/**
 * The durable execution-history extractor (RC-A / RC-B). It reconstructs the
 * gate-evidence log from persisted session messages — the same shape that
 * survives a resume/branch — rather than a volatile in-memory side-array.
 */

// Real message shapes (verified against on-disk session jsonl):
//   assistant.toolCall(bash).arguments.command + toolResult(bash).details.{exitCode,cwd}
//   toolResult(run).details.{argv,exitCode,cwd}
//   bashExecution (the `!` command path)
function assistantBash(id: string, command: string, cwd?: string) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: cwd ? { command, cwd } : { command } }] };
}
function toolResultBash(toolCallId: string, exitCode: number, cwd?: string) {
	return { role: "toolResult", toolCallId, toolName: "bash", isError: exitCode !== 0, details: { exitCode, ...(cwd ? { cwd } : {}) } };
}
function toolResultRun(argv: string[], exitCode: number, cwd?: string) {
	return { role: "toolResult", toolCallId: "r", toolName: "run", isError: exitCode !== 0, details: { argv, exitCode, ...(cwd ? { cwd } : {}) } };
}

describe("extractExecutionHistory", () => {
	it("pairs a bash toolCall with its toolResult by id (raw command + resolved cwd)", () => {
		const messages = [
			assistantBash("c1", "cd packages/djinn && mix test test/x_test.exs"),
			toolResultBash("c1", 0, "/repo/packages/djinn"),
		];
		expect(extractExecutionHistory(messages, "/repo")).toEqual([
			{ command: "cd packages/djinn && mix test test/x_test.exs", exitCode: 0, cwd: "/repo/packages/djinn" },
		]);
	});

	it("reconstructs a run-tool command from argv (RC-A: tool-agnostic)", () => {
		const messages = [toolResultRun(["mix", "test", "test/x_test.exs"], 0, "/repo/packages/djinn")];
		expect(extractExecutionHistory(messages, "/repo")).toEqual([
			{ command: "mix test test/x_test.exs", exitCode: 0, cwd: "/repo/packages/djinn" },
		]);
	});

	it("captures `!`-command bashExecution messages with the session cwd", () => {
		const messages = [{ role: "bashExecution", command: "bun test", exitCode: 0, cancelled: false }];
		expect(extractExecutionHistory(messages, "/repo")).toEqual([{ command: "bun test", exitCode: 0, cwd: "/repo" }]);
	});

	it("falls back to the cwd arg, then session cwd, when result details omit cwd", () => {
		const withArg = [assistantBash("c1", "bun test", "packages/x"), { role: "toolResult", toolCallId: "c1", toolName: "bash", details: {} }];
		expect(extractExecutionHistory(withArg, "/repo")[0]?.cwd).toBe("/repo/packages/x");
		const noArg = [assistantBash("c2", "bun test"), { role: "toolResult", toolCallId: "c2", toolName: "bash", details: {} }];
		expect(extractExecutionHistory(noArg, "/repo")[0]?.cwd).toBe("/repo");
	});

	it("records the failing exit code from result details", () => {
		const messages = [assistantBash("c1", "bun test"), toolResultBash("c1", 1, "/repo")];
		expect(extractExecutionHistory(messages, "/repo")[0]?.exitCode).toBe(1);
	});

	it("skips async-running placeholder results", () => {
		const messages = [
			assistantBash("c1", "bun test"),
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", details: { async: { state: "running" } } },
		];
		expect(extractExecutionHistory(messages, "/repo")).toEqual([]);
	});

	it("skips cancelled bashExecution messages and unpaired tool calls", () => {
		const messages = [
			{ role: "bashExecution", command: "bun test", exitCode: 0, cancelled: true },
			assistantBash("orphan", "no result"), // no matching toolResult
		];
		expect(extractExecutionHistory(messages, "/repo")).toEqual([]);
	});

	it("preserves order across mixed bash, run, and ! executions", () => {
		const messages = [
			assistantBash("c1", "bun test", undefined),
			toolResultBash("c1", 0, "/repo"),
			toolResultRun(["cargo", "test"], 0, "/repo"),
			{ role: "bashExecution", command: "bun lint", exitCode: 0, cancelled: false },
		];
		const log = extractExecutionHistory(messages, "/repo");
		expect(log.map(e => e.command)).toEqual(["bun test", "cargo test", "bun lint"]);
	});

	it("RC-B: a gate matches off the durable log after a simulated resume", () => {
		// A resume rebuilds agent.state.messages from the persisted transcript; the
		// extractor reads those, so evidence survives where a volatile array would
		// have been wiped. Model that by extracting from the persisted messages
		// directly and matching the gate.
		const persistedAfterResume = [
			assistantBash("c1", "cd packages/djinn && mix test test/x_test.exs"),
			toolResultBash("c1", 0, "/repo/packages/djinn"),
		];
		const executions = [...extractExecutionHistory(persistedAfterResume, "/repo")];
		expect(matchesGateCmd("cd packages/djinn && mix test test/x_test.exs", executions, "/repo")).toBe(true);
	});
});
