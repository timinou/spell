import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { GitBaseline, GitBaselineDiff } from "../../src/session/git-baseline";
import type { ToolSession } from "../../src/tools";
import { type TodoGroup, TodoWriteTool } from "../../src/tools/todo-write";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function createSession(initialGroups: TodoGroup[] = [], overrides: Partial<ToolSession> = {}): ToolSession {
	let groups = initialGroups;
	const eventBus = new FakeEventBus();
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "sess-test",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		eventBus,
		getTodoGroups: () => groups,
		setTodoGroups: next => {
			groups = next;
		},
		...overrides,
	};
}

function textSummary(result: Awaited<ReturnType<TodoWriteTool["execute"]>>): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("direct-work gate enforcement", () => {
	test("verified completion fails when gateCmd evidence is missing", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Run tests", gateCmd: "bun test" }] }] }],
		});
		await tool.execute("call-2", { ops: [{ op: "update", id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.groups[0]?.tasks[0]?.status).toBe("in_progress");
		expect(textSummary(result)).toContain("--- Gate Verification Failed ---");
		expect(textSummary(result)).toContain(
			"gateCmd: expected `bun test`, No successful execution matched the gate command.",
		);
	});

	test("captures a git baseline on in_progress and fails gateCommit when HEAD does not move", async () => {
		const baseline: GitBaseline = {
			head: "baseline-head-1",
			capturedAt: "2026-04-08T00:00:00.000Z",
			repoRoot: "/tmp/test",
		};
		const diff: GitBaselineDiff = {
			hasChanges: false,
			changedFiles: [],
			headAdvanced: false,
			currentHead: baseline.head,
		};
		const tool = new TodoWriteTool(
			createSession([], {
				captureGitBaseline: async () => baseline,
				compareGitBaseline: async () => diff,
			}),
		);
		await tool.execute("call-1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Commit work", gateCommit: true }] }] }],
		});

		const started = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "in_progress" }],
		});
		expect(started.details?.groups[0]?.tasks[0]?.gitBaseline).toEqual(baseline);

		const result = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.groups[0]?.tasks[0]?.status).toBe("in_progress");
		expect(textSummary(result)).toContain(
			"gateCommit: expected `git commit`, HEAD did not move after the task entered in_progress.",
		);
	});

	test("verified completion succeeds when gateCmd and gateCommit evidence both pass", async () => {
		const baseline: GitBaseline = {
			head: "baseline-head-2",
			capturedAt: "2026-04-08T00:00:00.000Z",
			repoRoot: "/tmp/test",
		};
		const diff: GitBaselineDiff = {
			hasChanges: true,
			changedFiles: ["src/task.ts"],
			headAdvanced: true,
			currentHead: "advanced-head-2",
		};
		const tool = new TodoWriteTool(
			createSession([], {
				getBashHistory: () => [{ command: "bun test", exitCode: 0, cwd: "/tmp/test" }],
				captureGitBaseline: async () => baseline,
				compareGitBaseline: async () => diff,
			}),
		);
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					groups: [{ name: "Work", tasks: [{ content: "Ship it", gateCmd: "bun test", gateCommit: true }] }],
				},
			],
		});
		await tool.execute("call-2", { ops: [{ op: "update", id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.groups[0]?.tasks[0]?.status).toBe("completed");
		expect(textSummary(result)).not.toContain("--- Gate Verification Failed ---");
	});
});
