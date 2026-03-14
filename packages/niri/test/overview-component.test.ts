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
 */

import { describe, expect, it } from "bun:test";
import { OverviewComponent } from "../src/overview-component";
import type { AgentStatus, OverviewSnapshot } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[^m]*m/g, "");
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
							{ content: "Write tests", status: "completed" },
							{ content: "Fix types", status: "in_progress" },
							{ content: "Deploy", status: "pending" },
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
					{ name: "Phase 1", tasks: [{ content: "Task A", status: "completed" }] },
					{ name: "Phase 2", tasks: [{ content: "Task B", status: "pending" }] },
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
});
