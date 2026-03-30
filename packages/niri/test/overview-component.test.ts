/**
 * OverviewComponent tests.
 *
 * Contracts:
 *  - render() returns at least one line for every agent status.
 *  - Every line is exactly `width` visible columns wide (padded to fill).
 *  - Project name and session title appear in the rendered output.
 *  - Message count is visible.
 *  - Todo phase names and task content appear when provided.
 *  - The status label ("Idle", "Running", "Error", "Needs Input") is present.
 *  - invalidate() causes a fresh render on the next call.
 *  - update() replaces the snapshot and invalidates the cache.
 *  - Blocked tasks render with ⊘ icon and blocker labels.
 *  - Gate badges appear after gated task content.
 *  - Org badge appears for org-linked tasks.
 *  - Tasks without blockers/gates render identically to pre-enrichment behavior.
 */

import { describe, expect, it } from "bun:test";
import { OverviewComponent } from "../src/overview-component";
import type { AgentStatus, OverviewSnapshot, TodoItemSnapshot } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[^m]*m/g, "");
}

let taskCounter = 0;

/** Create a TodoItemSnapshot with defaults for new required fields. */
function makeTask(
	overrides: Partial<TodoItemSnapshot> & Pick<TodoItemSnapshot, "content" | "status">,
): TodoItemSnapshot {
	return {
		id: `task-${++taskCounter}`,
		blocked: false,
		hasGates: false,
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
	return {
		projectName: "myapp",
		sessionTitle: "refactor-session",
		messageCount: 7,
		todoPhases: [],
		agentStatus: "idle",
		...overrides,
	};
}

function renderPlain(component: OverviewComponent, width = 80): string {
	return component.render(width).map(stripAnsi).join("\n");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OverviewComponent", () => {
	it("renders at least one line for every agent status", () => {
		const statuses: AgentStatus[] = ["idle", "running", "needs_input", "error", "completed", "pending_approval"];
		for (const status of statuses) {
			const comp = new OverviewComponent(makeSnapshot({ agentStatus: status }));
			const lines = comp.render(80);
			expect(lines.length).toBeGreaterThan(0);
		}
	});

	it("every rendered line is exactly width visible columns", () => {
		const WIDTH = 80;
		const comp = new OverviewComponent(makeSnapshot());
		for (const line of comp.render(WIDTH)) {
			// Measure visible width after stripping ANSI
			const plain = stripAnsi(line);
			expect(plain.length).toBe(WIDTH);
		}
	});

	it("includes the project name", () => {
		const comp = new OverviewComponent(makeSnapshot({ projectName: "backdesk" }));
		expect(renderPlain(comp)).toContain("backdesk");
	});

	it("includes the session title", () => {
		const comp = new OverviewComponent(makeSnapshot({ sessionTitle: "my-refactor" }));
		expect(renderPlain(comp)).toContain("my-refactor");
	});

	it("includes the message count", () => {
		const comp = new OverviewComponent(makeSnapshot({ messageCount: 42 }));
		expect(renderPlain(comp)).toContain("42");
	});

	it("shows correct status labels for each status", () => {
		const expected: Record<AgentStatus, string> = {
			idle: "Idle",
			running: "Running",
			needs_input: "Needs Input",
			error: "Error",
			completed: "Completed",
			pending_approval: "Pending Approval",
			user_paused: "Paused",
		};
		for (const [status, label] of Object.entries(expected) as [AgentStatus, string][]) {
			const comp = new OverviewComponent(makeSnapshot({ agentStatus: status }));
			expect(renderPlain(comp)).toContain(label);
		}
	});

	it("renders todo phase names and task content", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Implementation",
						tasks: [
							makeTask({ content: "Write tests", status: "completed" }),
							makeTask({ content: "Fix types", status: "in_progress" }),
							makeTask({ content: "Deploy", status: "pending" }),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("Implementation");
		expect(plain).toContain("Write tests");
		expect(plain).toContain("Fix types");
		expect(plain).toContain("Deploy");
	});

	it("renders multiple phases", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{ name: "Phase 1", tasks: [makeTask({ content: "Task A", status: "completed" })] },
					{ name: "Phase 2", tasks: [makeTask({ content: "Task B", status: "pending" })] },
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("Phase 1");
		expect(plain).toContain("Phase 2");
	});

	it("renders singular 'message' for count of 1", () => {
		const comp = new OverviewComponent(makeSnapshot({ messageCount: 1 }));
		expect(renderPlain(comp)).toContain("1 message");
		expect(renderPlain(comp)).not.toContain("1 messages");
	});

	it("renders plural 'messages' for count > 1", () => {
		const comp = new OverviewComponent(makeSnapshot({ messageCount: 5 }));
		expect(renderPlain(comp)).toContain("5 messages");
	});

	it("caches the render result for the same width", () => {
		const comp = new OverviewComponent(makeSnapshot());
		const first = comp.render(80);
		const second = comp.render(80);
		// Same array reference means cache was used
		expect(first).toBe(second);
	});

	it("invalidate() causes a new render on the next call", () => {
		const comp = new OverviewComponent(makeSnapshot());
		const first = comp.render(80);
		comp.invalidate();
		const second = comp.render(80);
		// After invalidation the cache is cleared — different array reference
		expect(first).not.toBe(second);
		// But content should be the same
		expect(stripAnsi(first.join("\n"))).toBe(stripAnsi(second.join("\n")));
	});

	it("update() replaces snapshot and invalidates cache", () => {
		const comp = new OverviewComponent(makeSnapshot({ projectName: "old" }));
		comp.render(80); // prime cache
		comp.update(makeSnapshot({ projectName: "new" }));
		const plain = renderPlain(comp);
		expect(plain).toContain("new");
		expect(plain).not.toContain("old");
	});

	it("re-renders at a different width", () => {
		const comp = new OverviewComponent(makeSnapshot());
		const narrow = comp.render(40);
		const wide = comp.render(120);
		// All lines must match their respective widths
		for (const line of narrow) expect(stripAnsi(line).length).toBe(40);
		for (const line of wide) expect(stripAnsi(line).length).toBe(120);
	});

	// ── Enrichment: blocked tasks ──────────────────────────────────────────

	it("renders blocked tasks with ⊘ icon instead of ○", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Deploy",
						tasks: [
							makeTask({ content: "Create schema", status: "pending" }),
							makeTask({
								content: "Deploy staging",
								status: "pending",
								blocked: true,
								blockerLabels: ["Create schema"],
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		// The blocked task uses ⊘ instead of ○
		expect(plain).toContain("\u2298 Deploy staging");
		// The unblocked pending task still uses ○
		expect(plain).toContain("\u25CB Create schema");
	});

	it("renders blocker labels after blocked task content", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Work",
						tasks: [
							makeTask({
								content: "Run tests",
								status: "pending",
								blocked: true,
								blockerLabels: ["Fix lint"],
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		// ← followed by blocker label
		expect(plain).toContain("\u2190 Fix lint");
	});

	it("renders overflow count for multiple blockers", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Work",
						tasks: [
							makeTask({
								content: "Integration tests",
								status: "pending",
								blocked: true,
								blockerLabels: ["Build API", "Add UI", "Write docs"],
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		// Shows first blocker + overflow
		expect(plain).toContain("Build API +2");
	});

	// ── Enrichment: gate badges ────────────────────────────────────────────

	it("renders gate badges after gated task content", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Release",
						tasks: [
							makeTask({
								content: "Add auth module",
								status: "in_progress",
								hasGates: true,
								gateBadges: ["commit", "cmd"],
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("[commit]");
		expect(plain).toContain("[cmd]");
	});

	it("renders all gate badge types", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Verify",
						tasks: [
							makeTask({
								content: "Full check",
								status: "pending",
								hasGates: true,
								gateBadges: ["commit", "cmd", "artifact", "llm", "verify"],
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("[commit]");
		expect(plain).toContain("[cmd]");
		expect(plain).toContain("[artifact]");
		expect(plain).toContain("[llm]");
		expect(plain).toContain("[verify]");
	});

	// ── Enrichment: org badge ──────────────────────────────────────────────

	it("renders [org] badge for org-linked tasks", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Tracked",
						tasks: [
							makeTask({
								content: "Auth refactor",
								status: "in_progress",
								orgItemId: "FEAT-042-auth",
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("[org]");
	});

	it("does not render [org] badge when orgItemId is absent", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Untracked",
						tasks: [makeTask({ content: "Quick fix", status: "in_progress" })],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).not.toContain("[org]");
	});

	// ── Enrichment: combined badges ────────────────────────────────────────

	it("renders blocked icon + blocker label + gate badges + org badge together", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Deploy",
						tasks: [
							makeTask({
								content: "Deploy staging",
								status: "pending",
								blocked: true,
								blockerLabels: ["Create schema"],
								hasGates: true,
								gateBadges: ["commit"],
								orgItemId: "FEAT-100-deploy",
							}),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		expect(plain).toContain("\u2298 Deploy staging");
		expect(plain).toContain("\u2190 Create schema");
		expect(plain).toContain("[commit]");
		expect(plain).toContain("[org]");
	});

	// ── Backward compatibility ─────────────────────────────────────────────

	it("renders plain tasks identically when no enrichment fields are active", () => {
		const comp = new OverviewComponent(
			makeSnapshot({
				todoPhases: [
					{
						name: "Simple",
						tasks: [
							makeTask({ content: "Do thing", status: "pending" }),
							makeTask({ content: "Done thing", status: "completed" }),
						],
					},
				],
			}),
		);
		const plain = renderPlain(comp);
		// Unblocked pending still uses ○
		expect(plain).toContain("\u25CB Do thing");
		// Completed still uses ✓
		expect(plain).toContain("\u2713 Done thing");
		// No badge noise (gate/org badges or blocker arrows)
		expect(plain).not.toContain("[commit]");
		expect(plain).not.toContain("[cmd]");
		expect(plain).not.toContain("[org]");
		expect(plain).not.toContain("\u2190");
	});
});
