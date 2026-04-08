import { describe, expect, it } from "bun:test";
import { cloneTrackedBashHistory, extractTrackedBashExecution } from "../../src/session/bash-tool-history";
import type { TrackedBashExecution } from "../../src/task/gate-verification";

describe("bash tool history", () => {
	it("extracts successful bash executions from tool args and result details", () => {
		const execution = extractTrackedBashExecution(
			{ command: "bun test", cwd: "packages/coding-agent" },
			{ content: [{ type: "text", text: "ok" }], details: { exitCode: 0, cwd: "/repo/packages/coding-agent" } },
			false,
			"/repo",
		);

		expect(execution).toEqual({
			command: "bun test",
			exitCode: 0,
			cwd: "/repo/packages/coding-agent",
		});
	});

	it("extracts failing exit codes from rendered error text when details are incomplete", () => {
		const execution = extractTrackedBashExecution(
			{ command: "bun test" },
			{ content: [{ type: "text", text: "stderr\n\nCommand exited with code 23" }], details: {} },
			true,
			"/repo",
		);

		expect(execution).toEqual({
			command: "bun test",
			exitCode: 23,
			cwd: "/repo",
		});
	});

	it("ignores async-running bash placeholder results", () => {
		const execution = extractTrackedBashExecution(
			{ command: "bun test" },
			{ content: [{ type: "text", text: "Background job started" }], details: { async: { state: "running" } } },
			false,
			"/repo",
		);

		expect(execution).toBeUndefined();
	});

	it("returns immutable snapshots instead of leaking internal history entries", () => {
		const source: TrackedBashExecution[] = [{ command: "echo original", exitCode: 0, cwd: "/repo" }];
		const snapshot = cloneTrackedBashHistory(source) as TrackedBashExecution[];

		source[0]!.command = "mutated-source";
		expect(snapshot[0]?.command).toBe("echo original");

		snapshot[0]!.command = "mutated-snapshot";
		expect(source[0]?.command).toBe("mutated-source");
		expect(snapshot[0]?.command).toBe("mutated-snapshot");
	});
});
