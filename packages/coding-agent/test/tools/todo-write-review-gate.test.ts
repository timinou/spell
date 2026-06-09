/**
 * verify.review LLM-gating (PLAN-330b).
 *
 * Contracts:
 *   - A completed node carrying verify.review runs the injected ReviewJudge.
 *   - pass verdict  → node completes.
 *   - fail verdict  → node reverts to its previous status + Gate Verification
 *     Failed section with the reason and a review-specific retry instruction.
 *   - degraded verdict (fail-open) → node completes + INFO notice; never wedged.
 *   - todo.reviewJudge = false → judge never consulted (advisory only).
 *   - no judge wired → advisory only (legacy behaviour preserved).
 *   - parseVerdict tolerates fences/prose/garbage.
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { TodoNode } from "../../src/tools/todo-write";
import { TodoWriteTool } from "../../src/tools/todo-write";
import { parseVerdict, type ReviewJudge, type ReviewJudgeVerdict } from "../../src/tools/review-judge";

function createSession(
	overrides: Partial<ToolSession> = {},
	settingsOverrides: Record<string, unknown> = {},
): ToolSession {
	let nodes: TodoNode[] = [];
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(settingsOverrides)) settings.set(key as never, value as never);
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getCompactContext: () => "agent did X then Y",
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
		...overrides,
	} as unknown as ToolSession;
}

const judgeReturning = (verdict: ReviewJudgeVerdict): ReviewJudge => async () => verdict;

async function completeReviewNode(session: ToolSession) {
	const tool = new TodoWriteTool(session);
	await tool.execute("c1", { reset: true, tasks: [{ content: "Build feature", verify: { review: "feature works end to end" } }] });
	await tool.execute("c2", { tasks: [{ id: "task-1", status: "in_progress" }] });
	return tool.execute("c3", { tasks: [{ id: "task-1", status: "completed" }] });
}

describe("verify.review LLM-gating", () => {
	test("pass verdict completes the node", async () => {
		const session = createSession({ getReviewJudge: () => judgeReturning({ pass: true, reason: "all good" }) });
		const result = await completeReviewNode(session);
		expect(result.details?.nodes?.[0]?.status).toBe("completed");
	});

	test("fail verdict reverts node + surfaces reason", async () => {
		const session = createSession({ getReviewJudge: () => judgeReturning({ pass: false, reason: "no tests found" }) });
		const result = await completeReviewNode(session);
		expect(result.details?.nodes?.[0]?.status).toBe("in_progress");
		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).toContain("--- Gate Verification Failed ---");
		expect(summary).toContain("verify.review");
		expect(summary).toContain("no tests found");
		expect(summary).toContain("Address the review feedback");
		expect(summary).not.toContain("retry with verified: true");
	});

	test("degraded verdict fails open (completes) with INFO notice", async () => {
		const session = createSession({
			getReviewJudge: () => judgeReturning({ pass: true, reason: "judge unavailable", degraded: true }),
		});
		const result = await completeReviewNode(session);
		expect(result.details?.nodes?.[0]?.status).toBe("completed");
		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).toContain("review not gated");
	});

	test("todo.reviewJudge=false keeps review advisory (judge not consulted)", async () => {
		let consulted = false;
		const session = createSession(
			{
				getReviewJudge: () => {
					consulted = true;
					return judgeReturning({ pass: false, reason: "should not run" });
				},
			},
			{ "todo.reviewJudge": false },
		);
		const result = await completeReviewNode(session);
		expect(consulted).toBe(false);
		expect(result.details?.nodes?.[0]?.status).toBe("completed");
	});

	test("no judge wired keeps review advisory", async () => {
		const session = createSession(); // no getReviewJudge
		const result = await completeReviewNode(session);
		expect(result.details?.nodes?.[0]?.status).toBe("completed");
	});

	test("review gate is single-phase: no verified flag required", async () => {
		// fail then pass — second completion (still no verified) goes through.
		let verdict: ReviewJudgeVerdict = { pass: false, reason: "incomplete" };
		const session = createSession({ getReviewJudge: () => async () => verdict });
		const tool = new TodoWriteTool(session);
		await tool.execute("c1", { reset: true, tasks: [{ content: "X", verify: { review: "criteria" } }] });
		await tool.execute("c2", { tasks: [{ id: "task-1", status: "in_progress" }] });
		const rejected = await tool.execute("c3", { tasks: [{ id: "task-1", status: "completed" }] });
		expect(rejected.details?.nodes?.[0]?.status).toBe("in_progress");
		verdict = { pass: true, reason: "now complete" };
		const accepted = await tool.execute("c4", { tasks: [{ id: "task-1", status: "completed" }] });
		expect(accepted.details?.nodes?.[0]?.status).toBe("completed");
	});
});

describe("parseVerdict", () => {
	test("plain JSON", () => {
		expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: "ok" });
	});
	test("fenced JSON", () => {
		expect(parseVerdict('```json\n{"pass": false, "reason": "nope"}\n```')).toEqual({ pass: false, reason: "nope" });
	});
	test("JSON embedded in prose", () => {
		expect(parseVerdict('Here is my verdict: {"pass": true, "reason": "done"} thanks')).toEqual({ pass: true, reason: "done" });
	});
	test("missing pass field → undefined", () => {
		expect(parseVerdict('{"reason": "no verdict"}')).toBeUndefined();
	});
	test("garbage → undefined", () => {
		expect(parseVerdict("not json at all")).toBeUndefined();
	});
	test("reason optional → empty string", () => {
		expect(parseVerdict('{"pass": true}')).toEqual({ pass: true, reason: "" });
	});
});
