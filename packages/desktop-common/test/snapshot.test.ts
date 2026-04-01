import { describe, expect, it } from "bun:test";
import type { SnapshotContext } from "../src/snapshot";
import { buildOverviewSnapshot } from "../src/snapshot";

function makeCtx(overrides: Partial<SnapshotContext> = {}): SnapshotContext {
	return {
		projectName: "myapp",
		sessionTitle: "test-session",
		messageCount: 5,
		agentStatus: "running",
		todoPhases: [],
		...overrides,
	};
}

describe("buildOverviewSnapshot", () => {
	it("produces a snapshot with correct top-level fields", () => {
		const snap = buildOverviewSnapshot(makeCtx());
		expect(snap.projectName).toBe("myapp");
		expect(snap.sessionTitle).toBe("test-session");
		expect(snap.messageCount).toBe(5);
		expect(snap.agentStatus).toBe("running");
		expect(snap.todoPhases).toEqual([]);
	});

	it("resolves blocked status from blocker task states", () => {
		const snap = buildOverviewSnapshot(
			makeCtx({
				todoPhases: [
					{
						id: "phase-1",
						name: "Phase 1",
						tasks: [
							{ id: "t1", content: "First", status: "pending" },
							{ id: "t2", content: "Second", status: "pending", blockers: ["t1"] },
						],
					},
				],
			}),
		);
		const tasks = snap.todoPhases[0].tasks;
		expect(tasks[0].blocked).toBe(false);
		expect(tasks[1].blocked).toBe(true);
		expect(tasks[1].blockerLabels).toEqual(["First"]);
	});

	it("does not mark task as blocked when blocker is completed", () => {
		const snap = buildOverviewSnapshot(
			makeCtx({
				todoPhases: [
					{
						id: "phase-1",
						name: "Phase 1",
						tasks: [
							{ id: "t1", content: "First", status: "completed" },
							{ id: "t2", content: "Second", status: "pending", blockers: ["t1"] },
						],
					},
				],
			}),
		);
		expect(snap.todoPhases[0].tasks[1].blocked).toBe(false);
	});

	it("collects gate badges", () => {
		const snap = buildOverviewSnapshot(
			makeCtx({
				todoPhases: [
					{
						name: "P1",
						tasks: [{ id: "t1", content: "Gated", status: "pending", gateCommit: true, gateCmd: "bun test" }],
					},
				],
			}),
		);
		expect(snap.todoPhases[0].tasks[0].gateBadges).toEqual(["commit", "cmd"]);
	});

	it("computes doneCount from in-data completed and cleared counts", () => {
		const cleared = new Map([["phase-1", { name: "Phase 1", count: 3 }]]);
		const snap = buildOverviewSnapshot(
			makeCtx({
				todoPhases: [
					{
						id: "phase-1",
						name: "Phase 1",
						tasks: [
							{ id: "t1", content: "Done", status: "completed" },
							{ id: "t2", content: "Pending", status: "pending" },
						],
					},
				],
				clearedCompletedCounts: cleared,
			}),
		);
		// 1 in-data completed + 3 cleared = 4
		expect(snap.todoPhases[0].doneCount).toBe(4);
	});

	it("adds phantom phases for cleared phases not in active data", () => {
		const cleared = new Map([["old-phase", { name: "Old Phase", count: 5 }]]);
		const snap = buildOverviewSnapshot(makeCtx({ clearedCompletedCounts: cleared }));
		expect(snap.todoPhases).toHaveLength(1);
		expect(snap.todoPhases[0].name).toBe("Old Phase");
		expect(snap.todoPhases[0].doneCount).toBe(5);
		expect(snap.todoPhases[0].tasks).toEqual([]);
	});
});

it("preserves nested child phases on delegated tasks", () => {
	const snap = buildOverviewSnapshot(
		makeCtx({
			todoPhases: [
				{
					id: "phase-1",
					name: "Parent",
					tasks: [
						{
							id: "t1",
							content: "Parent task",
							status: "in_progress",
							childPhases: [
								{
									name: "Delegated Work",
									tasks: [{ id: "c1", content: "Nested task", status: "pending" }],
								},
							],
						},
					],
				},
			],
		}),
	);
	expect(snap.todoPhases[0].tasks[0].childPhases?.[0]?.name).toBe("Delegated Work");
	expect(snap.todoPhases[0].tasks[0].childPhases?.[0]?.tasks[0]).toMatchObject({
		content: "Nested task",
		status: "pending",
	});
});
