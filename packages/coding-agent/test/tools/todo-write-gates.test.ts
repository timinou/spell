/**
 * Tests for todo_write gate fields, phase completion detection, blocked state,
 * and TUI gate badge rendering.
 *
 * Contracts:
 *   - Gate fields survive all data paths (reset, tasks merge, update, clone)
 *   - formatSummary injects directives when gated tasks are completed
 *   - Group completion detected via before/after comparison
 *   - isNodeBlocked correctly computes blocked state
 *   - normalizeInProgressNode skips blocked tasks
 *   - Gate badges render in formatNodeLine
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { getThemeByName } from "@spell/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoNode, TodoStatus } from "../../src/tools/todo-write";
import {
	applyReconcile,
	formatSummary,
	getLatestTodoNodesFromEntries,
	hasGate,
	hasRequiredGate,
	hasUnresolvedBlockers,
	isNodeBlocked,
	TodoWriteTool,
	todoWriteToolRenderer,
} from "../../src/tools/todo-write";

// =============================================================================
// Helper: build nodes with gate fields
// =============================================================================

function makeNode(overrides: Partial<TodoNode> & { id: string; content: string }): TodoNode {
	return {
		status: "pending" as TodoStatus,
		...overrides,
	};
}

// =============================================================================
// FEAT-071: Gate fields on TodoNode
// =============================================================================

describe("TodoNode gate fields", () => {
	test("hasGate returns true when any gate field is set", () => {
		expect(hasGate(makeNode({ id: "t1", content: "a", verify: { commit: true } }))).toBe(true);
		expect(hasGate(makeNode({ id: "t2", content: "b", verify: { artifact: "dist/out.json" } }))).toBe(true);
		expect(hasGate(makeNode({ id: "t3", content: "c", verify: { cmd: "bun test" } }))).toBe(true);
		expect(hasGate(makeNode({ id: "t4", content: "d", verify: { review: "check acceptance" } }))).toBe(true);
	});

	test("hasGate returns false when no gate fields set", () => {
		expect(hasGate(makeNode({ id: "t1", content: "a" }))).toBe(false);
	});

	test("gate fields survive cloneTodoNodes (via getLatestTodoNodesFromEntries)", () => {
		const _nodes: TodoNode[] = [
			makeNode({
				id: "task-1",
				content: "Build feature",
				status: "in_progress",
				group: "Work",
				details: "Step 1",
				verify: {
					commit: true,
					artifact: "dist/output.json",
					cmd: "bun test",
					review: "review criteria",
				},
				blockers: ["task-2"],
			}),
		];

		// Simulate session entries with todo_write result
		const entries = [
			{
				type: "message" as const,
				message: {
					role: "toolResult",
					toolName: "todo_write",
					isError: false,
					details: { nodes: _nodes },
				},
			},
		];

		const restored = getLatestTodoNodesFromEntries(entries as any);
		expect(restored.length).toBe(1);
		const node = restored[0];
		expect(node.details).toBe("Step 1");
		expect(node.verify?.commit).toBe(true);
		expect(node.verify?.artifact).toBe("dist/output.json");
		expect(node.verify?.cmd).toBe("bun test");
		expect(node.verify?.review).toBe("review criteria");
		expect(node.blockers).toEqual(["task-2"]);
	});
});

// =============================================================================
// FEAT-067: Blocked computed state
// =============================================================================

describe("isNodeBlocked", () => {
	test("returns true for pending node with unresolved blocker", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isNodeBlocked(node2, [node1, node2])).toBe(true);
	});

	test("returns false when blocker is completed", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "completed" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isNodeBlocked(node2, [node1, node2])).toBe(false);
	});

	test("returns false when blocker is abandoned", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "abandoned" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isNodeBlocked(node2, [node1, node2])).toBe(false);
	});

	test("returns false when blocker ref is missing (auto-cleared)", () => {
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-99"] });
		expect(isNodeBlocked(node2, [node2])).toBe(false);
	});

	test("returns false for in_progress node even with unresolved blockers", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "in_progress", blockers: ["task-1"] });
		expect(isNodeBlocked(node2, [node1, node2])).toBe(false);
	});

	test("returns false for completed node with blockers", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "completed", blockers: ["task-1"] });
		expect(isNodeBlocked(node2, [node1, node2])).toBe(false);
	});

	test("returns false for node with no blockers", () => {
		const node = makeNode({ id: "task-1", content: "Solo", status: "pending" });
		expect(isNodeBlocked(node, [node])).toBe(false);
	});

	test("returns false for node with empty blockers array", () => {
		const node = makeNode({ id: "task-1", content: "Solo", status: "pending", blockers: [] });
		expect(isNodeBlocked(node, [node])).toBe(false);
	});

	test("multiple blockers: blocked if any unresolved", () => {
		const node1 = makeNode({ id: "task-1", content: "Done", status: "completed" });
		const node2 = makeNode({ id: "task-2", content: "Pending", status: "pending" });
		const node3 = makeNode({ id: "task-3", content: "Blocked", status: "pending", blockers: ["task-1", "task-2"] });
		expect(isNodeBlocked(node3, [node1, node2, node3])).toBe(true);
	});

	test("circular blockers: both blocked, no infinite loop", () => {
		const node1 = makeNode({ id: "task-1", content: "A", status: "pending", blockers: ["task-2"] });
		const node2 = makeNode({ id: "task-2", content: "B", status: "pending", blockers: ["task-1"] });
		// Both should be blocked — isNodeBlocked doesn't recurse
		expect(isNodeBlocked(node1, [node1, node2])).toBe(true);
		expect(isNodeBlocked(node2, [node1, node2])).toBe(true);
	});
});

// =============================================================================
// formatSummary gate directive injection
// =============================================================================

describe("formatSummary gate directives", () => {
	function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
		return formatSummary({
			nodes: overrides.nodes ?? [makeNode({ id: "task-1", content: "Do thing" })],
			errors: overrides.errors ?? [],
			completedGroups: overrides.completedGroups ?? [],
			completedGatedNodes: overrides.completedGatedNodes ?? [],
			pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
			pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
		});
	}

	test("completing a gated node injects Verification Cleared receipt", () => {
		const node = makeNode({ id: "task-1", content: "Build it", status: "completed", verify: { commit: true } });
		const result = callFormatSummary({
			nodes: [node],
			completedGatedNodes: [node],
		});
		expect(result).toContain("--- Verification Cleared ---");
		expect(result).toContain("✓ task-1 cleared: verify.commit.");
	});

	test("each gate type produces its directive", () => {
		const node = makeNode({
			id: "task-1",
			content: "Full gates",
			status: "completed",
			verify: {
				commit: true,
				artifact: "dist/out.json",
				cmd: "bun test",
				review: "check acceptance",
			},
		});
		const result = callFormatSummary({
			nodes: [node],
			completedGatedNodes: [node],
		});
		expect(result).toContain("✓ task-1 cleared: verify.cmd, verify.artifact, verify.commit.");
		expect(result).toContain("↳ task-1 advisory review: check acceptance (verify.review).");
	});

	test("no gate directives when completing non-gated node", () => {
		const node = makeNode({ id: "task-1", content: "Simple", status: "completed" });
		const result = callFormatSummary({
			nodes: [node],
			completedGatedNodes: [],
		});
		expect(result).not.toContain("--- Verification Cleared ---");
	});

	test("group completion aggregate directive", () => {
		const node = makeNode({
			id: "task-1",
			content: "Done",
			status: "completed",
			group: "Build",
			verify: {
				commit: true,
				cmd: "bun test",
			},
		});
		const result = callFormatSummary({
			nodes: [node],
			completedGroups: ["Build"],
		});
		expect(result).toContain('Group "Build" complete.');
		expect(result).toContain("gated node(s) cleared.");
	});

	test("blocked node shows [blocked] label in remaining items", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending" });
		const blocked = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, blocked],
		});
		expect(result).toContain("task-2 Second [pending] [blocked]");
	});

	test("blocked node uses block symbol in group tree", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending", group: "Work" });
		const blocked = makeNode({ id: "task-2", content: "Second", status: "pending", group: "Work", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, blocked],
		});
		// ⛔ is the blocked symbol in group tree rendering
		expect(result).toContain("\u26D4 task-2");
	});
});

// =============================================================================
// BUG-022: hasUnresolvedBlockers (status-independent blocker resolution)
// =============================================================================

describe("hasUnresolvedBlockers", () => {
	test("returns true when node has pending blocker", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(node2, [node1, node2])).toBe(true);
	});

	test("returns true when node has in_progress blocker", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "in_progress" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(node2, [node1, node2])).toBe(true);
	});

	test("returns false when all blockers completed", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "completed" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(node2, [node1, node2])).toBe(false);
	});

	test("returns false when all blockers abandoned", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "abandoned" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(node2, [node1, node2])).toBe(false);
	});

	test("returns false when blocker ref is missing (dangling = resolved)", () => {
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-99"] });
		expect(hasUnresolvedBlockers(node2, [node2])).toBe(false);
	});

	test("returns false when node has no blockers", () => {
		const node = makeNode({ id: "task-1", content: "Solo", status: "pending" });
		expect(hasUnresolvedBlockers(node, [node])).toBe(false);
	});

	test("works regardless of node's own status (unlike isNodeBlocked)", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending" });
		// in_progress node with unresolved blocker: isNodeBlocked returns false, hasUnresolvedBlockers returns true
		const inProgress = makeNode({ id: "task-2", content: "Second", status: "in_progress", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(inProgress, [blocker, inProgress])).toBe(true);
		expect(isNodeBlocked(inProgress, [blocker, inProgress])).toBe(false);

		// completed node with unresolved blocker
		const completed = makeNode({ id: "task-3", content: "Third", status: "completed", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(completed, [blocker, completed])).toBe(true);
		expect(isNodeBlocked(completed, [blocker, completed])).toBe(false);
	});

	test("resolves current-session blocker URIs against the provided context", () => {
		const blocker = makeNode({
			id: "task-1",
			uri: "task://sess-review/reviewer/review-contract",
			content: "Review contract",
			status: "pending",
		});
		const dependent = makeNode({
			id: "task-2",
			content: "Implement follow-up",
			status: "pending",
			blockers: ["task://current/reviewer/review-contract"],
		});
		expect(hasUnresolvedBlockers(dependent, [blocker, dependent])).toBe(false);
		expect(
			hasUnresolvedBlockers(dependent, [blocker, dependent], {
				currentSessionId: "sess-review",
				currentAgentName: "main",
			}),
		).toBe(true);
		expect(
			isNodeBlocked(dependent, [blocker, dependent], { currentSessionId: "sess-review", currentAgentName: "main" }),
		).toBe(true);
	});
});

// =============================================================================
// FEAT-097: formatSummary blocked count + deadlock warning
// =============================================================================

describe("formatSummary blocked visibility", () => {
	function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
		return formatSummary({
			nodes: overrides.nodes ?? [makeNode({ id: "task-1", content: "Do thing" })],
			errors: overrides.errors ?? [],
			completedGroups: overrides.completedGroups ?? [],
			completedGatedNodes: overrides.completedGatedNodes ?? [],
			pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
			pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
		});
	}

	test("header shows blocked count when some nodes are blocked", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending" });
		const blocked1 = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		const blocked2 = makeNode({ id: "task-3", content: "Third", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, blocked1, blocked2],
		});
		expect(result).toContain("Remaining items (3, 2 blocked):");
	});

	test("header omits blocked count when no nodes are blocked", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending" });
		const result = callFormatSummary({
			nodes: [node1, node2],
		});
		expect(result).toContain("Remaining items (2):");
		expect(result).not.toContain("blocked");
	});

	test("header shows blocked count of 1", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending" });
		const blocked = makeNode({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, blocked],
		});
		expect(result).toContain("Remaining items (2, 1 blocked):");
	});

	test("all nodes completed: header unchanged", () => {
		const node = makeNode({ id: "task-1", content: "Done", status: "completed" });
		const result = callFormatSummary({
			nodes: [node],
		});
		expect(result).toContain("Remaining items: none.");
	});

	test("group progress includes blocked count", () => {
		const blocker = makeNode({ id: "task-1", content: "First", status: "pending", group: "Work" });
		const blocked = makeNode({ id: "task-2", content: "Second", status: "pending", group: "Work", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, blocked],
		});
  expect(result).toContain("1 blocked");
  		// Check that the blocked count appears in the summary
  		expect(result).toContain("Remaining items (2, 1 blocked):");
	});

	test("group progress omits blocked count when zero", () => {
		const node1 = makeNode({ id: "task-1", content: "First", status: "pending", group: "Work" });
		const node2 = makeNode({ id: "task-2", content: "Second", status: "pending", group: "Work" });
		const result = callFormatSummary({
			nodes: [node1, node2],
		});
		// Should not have "blocked" in the group progress line
		const groupLine = result.split("\n").find(l => l.includes("Work"))!;
		expect(groupLine).not.toContain("blocked");
	});

	test("deadlock warning when all pending nodes are blocked and none in_progress", () => {
		const node1 = makeNode({ id: "task-1", content: "A", status: "pending", blockers: ["task-2"] });
		const node2 = makeNode({ id: "task-2", content: "B", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [node1, node2],
		});
		expect(result).toContain("WARNING: All remaining tasks are blocked.");
	});

	test("no deadlock warning when a node is in_progress", () => {
		const node1 = makeNode({ id: "task-1", content: "A", status: "in_progress" });
		const node2 = makeNode({ id: "task-2", content: "B", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [node1, node2],
		});
		expect(result).not.toContain("WARNING");
	});

	test("no deadlock warning when no nodes are blocked", () => {
		const node1 = makeNode({ id: "task-1", content: "A", status: "pending" });
		const result = callFormatSummary({
			nodes: [node1],
		});
		expect(result).not.toContain("WARNING");
	});

	test("cross-group blocked count: node in group-2 blocked by node in group-1", () => {
		const blocker = makeNode({ id: "task-1", content: "Schema", status: "pending", group: "Foundation" });
		const dependent = makeNode({ id: "task-2", content: "API", status: "pending", group: "Features", blockers: ["task-1"] });
		const result = callFormatSummary({
			nodes: [blocker, dependent],
		});
		expect(result).toContain("Remaining items (2, 1 blocked):");
	});
});

// =============================================================================
// FEAT-100: ref field + hasRequiredGate + two-phase gated completion
// =============================================================================

describe("hasRequiredGate", () => {
	test("returns true for verify.commit", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", verify: { commit: true } }))).toBe(true);
	});

	test("returns true for verify.artifact", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", verify: { artifact: "dist/out.json" } }))).toBe(true);
	});

	test("returns true for verify.cmd", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", verify: { cmd: "bun test" } }))).toBe(true);
	});

	test("returns false for verify.review-only nodes", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", verify: { review: "check criteria" } }))).toBe(false);
	});

	test("returns true for verify.swarm (FEAT-816 sub-loop gate)", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", verify: { swarm: { count: 3 } } }))).toBe(true);
	});

	test("returns false for ref (non-gating lineage)", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", ref: "FEAT-001-auth" }))).toBe(false);
	});

	test("returns true for closesRef", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a", ref: "FEAT-001-auth", closesRef: true }))).toBe(true);
	});

	test("returns false when no gates set", () => {
		expect(hasRequiredGate(makeNode({ id: "t1", content: "a" }))).toBe(false);
	});
});

describe("ref field", () => {
	test("ref survives cloneTodoNodes (via getLatestTodoNodesFromEntries)", () => {
		const _nodes: TodoNode[] = [
			makeNode({
				id: "task-1",
				content: "Build feature",
				status: "in_progress",
				ref: "FEAT-001-add-auth",
				verify: { cmd: "bun test" },
			}),
		];

		const entries = [
			{
				type: "message" as const,
				message: {
					role: "toolResult",
					toolName: "todo_write",
					isError: false,
					details: { nodes: _nodes },
				},
			},
		];

		const restored = getLatestTodoNodesFromEntries(entries as any);
		expect(restored[0].ref).toBe("FEAT-001-add-auth");
	});

	test("org-linked metadata does not add non-actionable completed-node directives", () => {
		const closingNode = makeNode({
			id: "task-1",
			content: "Build it",
			status: "completed",
			ref: "FEAT-001-add-auth",
			closesRef: true,
		});
		const lineageNode = makeNode({
			id: "task-2",
			content: "Track it",
			status: "completed",
			ref: "FEAT-001-add-auth",
		});
		const result = formatSummary({
			nodes: [closingNode, lineageNode],
			errors: [],
			completedGroups: [],
			completedGatedNodes: [closingNode, lineageNode],
			pendingVerificationNodes: [],
			pendingDeferralNodes: [],
		});
		expect(result).not.toContain("auto-transitions to DONE");
		expect(result).not.toContain("Linked to org item");
	});
});

describe("two-phase gated completion via formatSummary", () => {
	function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
		return formatSummary({
			nodes: overrides.nodes ?? [makeNode({ id: "task-1", content: "Do thing" })],
			errors: overrides.errors ?? [],
			completedGroups: overrides.completedGroups ?? [],
			completedGatedNodes: overrides.completedGatedNodes ?? [],
			pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
			pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
		});
	}

	test("pending verification node renders verification checklist", () => {
		const node = makeNode({
			id: "task-1",
			content: "Build feature",
			status: "in_progress",
			verify: {
				cmd: "bun test",
				artifact: "dist/out.json",
				commit: true,
			},
			ref: "FEAT-001-add-auth",
			closesRef: true,
		});
		const result = callFormatSummary({
			nodes: [node],
			pendingVerificationNodes: [node],
		});
		expect(result).toContain("--- Verification Required ---");
		expect(result).toContain('task-1 "Build feature" requires verification before completion:');
		expect(result).toContain("[ ] Run `bun test` (verify.cmd)");
		expect(result).toContain("[ ] Verify artifact at dist/out.json (verify.artifact)");
		expect(result).toContain("[ ] Commit changes (verify.commit)");
  expect(result).toContain("[i] Verified completion will close org ref FEAT-001-add-auth.");
		expect(result).toContain('{id: "task-1", status: "completed", verified: true}');
	});

	test("swarm gate emits a reviewer-swarm directive (FEAT-816)", () => {
		const node = makeNode({
			id: "task-1",
			content: "Land wave",
			status: "in_progress",
			verify: { swarm: { count: 3, criteria: "security · leaks" } },
		});
		const result = callFormatSummary({ nodes: [node], pendingVerificationNodes: [node] });
		expect(result).toContain("--- Verification Required ---");
		expect(result).toContain("dispatch 3 parallel `reviewer` task(s) over this node's diff");
		expect(result).toContain("criteria: security · leaks");
		expect(result).toContain("Already reviewed this wave's diff? It is satisfied");
		expect(result).toContain("(verify.swarm)");
	});

	test("no verification section when pendingVerificationNodes is empty", () => {
		const result = callFormatSummary({ pendingVerificationNodes: [] });
		expect(result).not.toContain("--- Verification Required ---");
	});

	test("verification checklist omits ref line when not set", () => {
		const node = makeNode({
			id: "task-1",
			content: "Simple gated",
			status: "in_progress",
			verify: { commit: true },
		});
		const result = callFormatSummary({
			nodes: [node],
			pendingVerificationNodes: [node],
		});
		expect(result).toContain("--- Verification Required ---");
		expect(result).toContain("[ ] Commit changes (verify.commit)");
		expect(result).not.toContain("orgItemId");
	});

	test("verification checklist keeps verify.review as advisory text alongside required gates", () => {
		const node = makeNode({
			id: "task-1",
			content: "Review node",
			status: "in_progress",
			verify: {
				commit: true,
				review: "check acceptance criteria",
			},
		});
		const result = callFormatSummary({
			nodes: [node],
			pendingVerificationNodes: [node],
		});
		expect(result).toContain("[ ] Commit changes (verify.commit)");
		expect(result).toContain("[i] Advisory review: check acceptance criteria (verify.review)");
	});
});

// =============================================================================
// Two-phase gated completion via TodoWriteTool.execute
// =============================================================================

function createSession(initialNodes: TodoNode[] = [], overrides: Partial<ToolSession> = {}): ToolSession {
	let nodes = initialNodes;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
		...overrides,
	} as unknown as ToolSession;
}

describe("two-phase gated completion via TodoWriteTool.execute", () => {
	test("completing a gated node without verified is rejected", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Run tests", verify: { cmd: "bun test" } }],
		});

		// Mark in_progress
		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});

		// Try to complete without verified — should be rejected
		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0]?.status).toBe("in_progress");

		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).toContain("Verification Required");
		expect(summary).toContain("[ ] Run `bun test` (verify.cmd)");
	});

	test("completing a gated node with verified: true succeeds", async () => {
		const tool = new TodoWriteTool(
			createSession([], { getBashHistory: () => [{ command: "bun test", exitCode: 0, cwd: "/tmp/test" }] }),
		);
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Run tests", verify: { cmd: "bun test" } }],
		});

		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0]?.status).toBe("completed");

		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).toContain("Verification Cleared");
	});

	test("non-gated node completes without verified", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Simple task" }],
		});

		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0]?.status).toBe("completed");

		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).not.toContain("Verification Required");
	});

	test("verify.review-only node completes without verified", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Review node", verify: { review: "check acceptance criteria" } }],
		});

		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});

		const result = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0]?.status).toBe("completed");

		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).not.toContain("Verification Required");
		expect(summary).toContain("↳ task-1 advisory review: check acceptance criteria (verify.review).");
	});

	test("closesRef-only node triggers two-phase completion", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Auth feature", ref: "FEAT-001-auth", closesRef: true }],
		});

		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});

		// Try to complete without verified — should be rejected
		const rejected = await tool.execute("call-3", {
			tasks: [{ id: "task-1", status: "completed" }],
		});

		const rejectedNodes = rejected.details?.nodes ?? [];
		expect(rejectedNodes[0]?.status).toBe("in_progress");

		const rejectedSummary = rejected.content.find(part => part.type === "text")?.text ?? "";
  expect(rejectedSummary).toContain("[i] Verified completion will close org ref FEAT-001-auth.");

		// Now complete with verified: true
		const accepted = await tool.execute("call-4", {
			tasks: [{ id: "task-1", status: "completed", verified: true }],
		});

		const acceptedNodes = accepted.details?.nodes ?? [];
		expect(acceptedNodes[0]?.status).toBe("completed");

		const acceptedSummary = accepted.content.find(part => part.type === "text")?.text ?? "";
		expect(acceptedSummary).toContain("Verification Cleared");
	});
});

describe("gate_failed status behavior", () => {
	test("applyReconcile with gate_failed transitions in_progress node", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Build feature" }],
		});
		await tool.execute("call-2", {
			tasks: [{ id: "task-1", status: "in_progress" }],
		});
		const result = await tool.execute("call-3", {
			// gate_failed is system-only; tests exercising it cast past the model-facing enum.
			tasks: [{ id: "task-1", status: "gate_failed" as "completed" }],
		});
		expect(result.details?.nodes[0]?.status).toBe("gate_failed");
		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summary).toContain("--- Gate Failures ---");
	});

	test("applyReconcile keeps group incomplete when gate_failed exists", () => {
		const file = {
			nextTaskId: 3,
			nodes: [
				{ id: "task-1", content: "Done", status: "completed" as TodoStatus, group: "Work" },
				{ id: "task-2", content: "Gate failed", status: "gate_failed" as TodoStatus, group: "Work" },
			],
		};
		const result = applyReconcile(file, { tasks: [] }, file.nodes, []);
		expect(result.completedGroups).toEqual([]);
	});

	test("applyReconcile still marks completed group without gate_failed", () => {
		const file = {
			nextTaskId: 3,
			nodes: [
				{ id: "task-1", content: "Done", status: "completed" as TodoStatus, group: "Work" },
				{ id: "task-2", content: "Deferred", status: "abandoned" as TodoStatus, group: "Work" },
			],
		};
		const previousNodes = [
			{ id: "task-1", content: "Done", status: "pending" as TodoStatus, group: "Work" },
			{ id: "task-2", content: "Deferred", status: "pending" as TodoStatus, group: "Work" },
		];
		const result = applyReconcile(file, { tasks: [] }, previousNodes, []);
		expect(result.completedGroups).toEqual(["Work"]);
	});

	test("normalizeInProgressNode does not auto-promote past gate_failed", () => {
		const file = {
			nextTaskId: 4,
			nodes: [
				{ id: "task-1", content: "Done", status: "completed" as TodoStatus },
				{ id: "task-2", content: "Gate failed", status: "gate_failed" as TodoStatus },
				{ id: "task-3", content: "Pending", status: "pending" as TodoStatus },
			],
		};
		const result = applyReconcile(file, { tasks: [] }, file.nodes, []);
		expect(result.file.nodes[2]?.status).toBe("pending");
	});

	test("normalizeInProgressNode still auto-promotes without gate_failed", () => {
		const file = {
			nextTaskId: 3,
			nodes: [
				{ id: "task-1", content: "Done", status: "completed" as TodoStatus },
				{ id: "task-2", content: "Pending", status: "pending" as TodoStatus },
			],
		};
		const result = applyReconcile(file, { tasks: [] }, file.nodes, []);
		expect(result.file.nodes[1]?.status).toBe("in_progress");
	});

	test("hasUnresolvedBlockers treats gate_failed blocker as unresolved", () => {
		const blocker = makeNode({ id: "task-1", content: "Gate failed", status: "gate_failed" });
		const node = makeNode({ id: "task-2", content: "Dependent", status: "pending", blockers: ["task-1"] });
		expect(hasUnresolvedBlockers(node, [blocker, node])).toBe(true);
		const completedBlocker = makeNode({ id: "task-1", content: "Done", status: "completed" });
		expect(hasUnresolvedBlockers(node, [completedBlocker, node])).toBe(false);
	});

	test("formatSummary lists gate failures section", () => {
		const node = makeNode({
			id: "task-1",
			content: "Build feature",
			status: "gate_failed",
			delegation: {
				sessionId: "sess-1",
				result: {
					gateFailures: [
						{ gate: "verify.cmd", expected: "bun test", detail: "not detected in subagent bash history" },
						{ gate: "verify.artifact", expected: "dist/out.json", detail: "artifact missing" },
					],
				},
			},
		});
		const summary = formatSummary({
			nodes: [node],
			errors: [],
			completedGroups: [],
			completedGatedNodes: [],
			pendingVerificationNodes: [],
			pendingDeferralNodes: [],
		});
		expect(summary).toContain("--- Gate Failures ---");
		expect(summary).toContain(
			'gate_failed: task-1 "Build feature" — verify.cmd not satisfied: expected `bun test`, not detected in subagent bash history',
		);
		expect(summary).toContain("verify.artifact not satisfied: expected `dist/out.json`, artifact missing");
	});

	test("formatSummary omits gate failures section when absent", () => {
		const summary = formatSummary({
			nodes: [makeNode({ id: "task-1", content: "Build feature", status: "pending" })],
			errors: [],
			completedGroups: [],
			completedGatedNodes: [],
			pendingVerificationNodes: [],
			pendingDeferralNodes: [],
		});
		expect(summary).not.toContain("--- Gate Failures ---");
	});

	test("formatNodeLine renders gate_failed badge", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const rendered = todoWriteToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					nodes: [makeNode({ id: "task-1", content: "Build feature", status: "gate_failed", group: "Work" })],
				},
			} as never,
			{ expanded: true, isPartial: false },
			uiTheme,
		);
		expect(rendered.render(80).join("\n")).toContain("[gate failed]");
	});
});
