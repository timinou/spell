import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { GitBaseline, GitBaselineDiff } from "../../src/session/git-baseline";
import type { ToolSession } from "../../src/tools";
import { type TodoNode, TodoWriteTool } from "../../src/tools/todo-write";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function createSession(initialNodes: TodoNode[] = [], overrides: Partial<ToolSession> = {}): ToolSession {
	let nodes = initialNodes;
	const eventBus = new FakeEventBus();
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "sess-test",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		eventBus,
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
		...overrides,
	} as unknown as ToolSession;
}

function textSummary(result: Awaited<ReturnType<TodoWriteTool["execute"]>>): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("direct-work gate enforcement", () => {
	test("verified completion fails when verify.cmd evidence is missing", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Run tests", group: "Work", verify: { cmd: "bun test" } }],
		});
		await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.nodes[0]?.status).toBe("in_progress");
		expect(textSummary(result)).toContain("--- Gate Verification Failed ---");
		expect(textSummary(result)).toContain(
			"gateCmd: expected `bun test`, No successful execution matched the gate command.",
		);
	});

	test("captures a git baseline on in_progress and fails verify.commit when HEAD does not move", async () => {
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
			reset: true,
			tasks: [{ content: "Commit work", group: "Work", verify: { commit: true } }],
		});

		const started = await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});
		expect(started.details?.nodes[0]?.gitBaseline).toEqual(baseline);

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.nodes[0]?.status).toBe("in_progress");
		expect(textSummary(result)).toContain(
			"gateCommit: expected `git commit`, HEAD did not move after the node entered in_progress.",
		);
	});

	test("verified completion succeeds when verify.cmd and verify.commit evidence both pass", async () => {
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
			reset: true,
			tasks: [{ content: "Ship it", group: "Work", verify: { cmd: "bun test", commit: true } }],
		});
		await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.nodes[0]?.status).toBe("completed");
		expect(textSummary(result)).not.toContain("--- Gate Verification Failed ---");
	});
});
