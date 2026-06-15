import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { captureGitBaseline } from "../../src/session/git-baseline";
import type { ExecutionRecord } from "../../src/task/gate-verification";
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

/** A git repo with one commit; yields the dir + baseline-capturing session factory. */
async function withGitRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "direct-gate-git-"));
	try {
		await $`git init -q`.cwd(dir).quiet().nothrow();
		await $`git config user.email test@example.com`.cwd(dir).quiet().nothrow();
		await $`git config user.name Test`.cwd(dir).quiet().nothrow();
		await fs.writeFile(path.join(dir, "seed.txt"), "x");
		await $`git add . && git commit -q -m seed`.cwd(dir).quiet().nothrow();
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function advanceHead(dir: string, name: string): Promise<void> {
	await fs.writeFile(path.join(dir, name), "y");
	await $`git add . && git commit -q -m ${name}`.cwd(dir).quiet().nothrow();
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

	test("verified completion succeeds when verify.cmd evidence is present in the durable log", async () => {
		const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/tmp/test" }];
		const tool = new TodoWriteTool(createSession([], { getExecutionHistory: () => executions }));
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Run tests", group: "Work", verify: { cmd: "bun test" } }],
		});
		await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.nodes[0]?.status).toBe("completed");
		expect(textSummary(result)).not.toContain("--- Gate Verification Failed ---");
	});

	test("a run-tool execution satisfies a verify.cmd gate (RC-A: tool-agnostic evidence)", async () => {
		// The durable execution log is tool-agnostic — a gate satisfied via the
		// `run` runtime tool (not bash) is honoured just the same.
		const executions: ExecutionRecord[] = [
			{ command: "mix test test/x_test.exs", exitCode: 0, cwd: "/tmp/test/packages/djinn" },
		];
		const tool = new TodoWriteTool(createSession([], { getExecutionHistory: () => executions }));
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "djinn tests", verify: { cmd: "cd packages/djinn && mix test test/x_test.exs" } }],
		});
		await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		expect(result.details?.nodes[0]?.status).toBe("completed");
	});

	test("captures a git baseline on in_progress and fails verify.commit when HEAD does not move", async () => {
		await withGitRepo(async dir => {
			const tool = new TodoWriteTool(
				createSession([], { cwd: dir, captureGitBaseline: () => captureGitBaseline(dir) }),
			);
			await tool.execute("call-1", {
				reset: true,
				tasks: [{ content: "Commit work", group: "Work", verify: { commit: true } }],
			});

			const started = await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });
			expect(started.details?.nodes[0]?.gitBaseline?.head).toMatch(/^[0-9a-f]{40}$/);

			// HEAD did not advance → commit gate fails.
			const result = await tool.execute("call-3", {
				tasks: [{ id: "task-1", status: "completed", verified: true }],
			});

			expect(result.details?.nodes[0]?.status).toBe("in_progress");
			expect(textSummary(result)).toContain(
				"gateCommit: expected `git commit`, HEAD did not advance past the pre-work baseline.",
			);
		});
	});

	test("verified completion succeeds when verify.cmd and verify.commit evidence both pass", async () => {
		await withGitRepo(async dir => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: dir }];
			const tool = new TodoWriteTool(
				createSession([], {
					cwd: dir,
					getExecutionHistory: () => executions,
					captureGitBaseline: () => captureGitBaseline(dir),
				}),
			);
			await tool.execute("call-1", {
				reset: true,
				tasks: [{ content: "Ship it", group: "Work", verify: { cmd: "bun test", commit: true } }],
			});
			await tool.execute("call-2", { tasks: [{ id: "task-1", status: "in_progress" }] });

			// Advance HEAD after the baseline is captured → commit gate passes.
			await advanceHead(dir, "ship.txt");

			const result = await tool.execute("call-3", {
				tasks: [{ id: "task-1", status: "completed", verified: true }],
			});

			expect(result.details?.nodes[0]?.status).toBe("completed");
			expect(textSummary(result)).not.toContain("--- Gate Verification Failed ---");
		});
	});

	test("RC-C repair: an explicit in_progress re-entry re-captures a missing commit baseline", async () => {
		await withGitRepo(async dir => {
			const tool = new TodoWriteTool(
				createSession([], { cwd: dir, captureGitBaseline: () => captureGitBaseline(dir) }),
			);
			// Simulate a legacy/wiped node: it carries a commit gate and is already
			// in_progress with NO baseline (as if it entered in_progress before the
			// field existed or in a since-wiped session).
			await tool.execute("call-1", {
				reset: true,
				tasks: [{ id: "legacy", content: "Commit work", verify: { commit: true }, status: "in_progress" }],
			});
			// First entry captured a baseline (pending→in_progress). Strip it to model
			// the stuck legacy state, then advance HEAD.
			const nodes = tool["session"].getTodoNodes?.() ?? [];
			const legacy = nodes.find(n => n.id === "legacy");
			if (legacy) legacy.gitBaseline = undefined;
			tool["session"].setTodoNodes?.(nodes);
			await advanceHead(dir, "legacy-fix.txt");

			// Without repair the gate would be stuck (no baseline). An explicit
			// in_progress re-entry re-captures the baseline at the CURRENT head…
			await tool.execute("call-2", { tasks: [{ id: "legacy", status: "in_progress" }] });
			const reentered = tool["session"].getTodoNodes?.()?.find(n => n.id === "legacy");
			expect(reentered?.gitBaseline?.head).toMatch(/^[0-9a-f]{40}$/);

			// …then a NEW commit advances past it and the gate clears.
			await advanceHead(dir, "legacy-fix-2.txt");
			const result = await tool.execute("call-3", {
				tasks: [{ id: "legacy", status: "completed", verified: true }],
			});
			expect(result.details?.nodes.find(n => n.id === "legacy")?.status).toBe("completed");
		});
	});
});
