/**
 * Dev-only demo seed for the REAL app (App.svelte), gated behind `?demo` in a
 * Vite dev build. It populates the live `app` store with representative sessions
 * and every bubble kind — including the PLAN-338 edit accents and diff bodies —
 * so the design can be viewed by running the actual product entry (index.html),
 * with no backend, login, or WebSocket. Production builds never call this
 * (callers guard on `import.meta.env.DEV`), and it is tree-shaken out of the
 * production bundle because the guard is statically false.
 */
import { app } from "./stores.svelte";
import type { ChatBubble } from "./reducers";
import type { EditHistoryResult, SessionSummary } from "./protocol";

/** True when the app should boot into the offline demo (dev + `?demo`). */
export function demoRequested(): boolean {
	if (!import.meta.env.DEV) return false;
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).has("demo");
}

const MIN = 60_000;

function sampleBubbles(now: number): ChatBubble[] {
	return [
		{ id: "u1", kind: "user", ts: now - 9 * MIN, text: "Refactor the Registry class to Store and fix the broken undo." },
		{
			id: "a1",
			kind: "assistant",
			ts: now - 9 * MIN + 2000,
			text: "On it. I'll rename Registry → Store across the core package, then trace the undo regression.",
		},
		{
			id: "t1",
			kind: "tool_start",
			ts: now - 9 * MIN + 4000,
			toolName: "edit",
			args: { target: "packages/core/src/registry.ts::Registry", action: { kind: "rename", to: "Store" } },
		},
		{
			id: "t1b",
			kind: "tool_start",
			ts: now - 9 * MIN + 5000,
			toolName: "find",
			args: { target: "packages/core/src/**/*.ts::§call[name=Registry]" },
		},
		{
			id: "t2",
			kind: "tool_end",
			ts: now - 9 * MIN + 6000,
			toolName: "edit",
			text: "renamed Registry → Store · 3 files, 11 references updated",
		},
		{
			id: "th1",
			kind: "assistant_thinking",
			ts: now - 8 * MIN,
			text: "The undo reverted a committed file because the recorder used a single global log. Need session scoping + a commit guard.",
		},
		{
			id: "te1",
			kind: "tool_end",
			ts: now - 7 * MIN,
			toolName: "edit",
			text:
				"undo · packages/core/src/registry.ts\n@@ -1 +1 @@\n-export class Store {\n+export class Registry {\n\nundo · packages/core/src/index.ts\n@@ -3 +3 @@\n-import { Store }\n+import { Registry }",
		},
		{
			id: "te2",
			kind: "tool_end",
			ts: now - 6 * MIN,
			toolName: "edit",
			text: "redo · packages/core/src/registry.ts\n@@ -1 +1 @@\n-export class Registry {\n+export class Store {",
		},
		{
			id: "te3",
			kind: "tool_end",
			ts: now - 5 * MIN,
			toolName: "edit",
			text:
				"undo declined: already committed — packages/core/src/store.ts (a1b2c3d)\n  • re-run with force to revert anyway\n  • or use `git revert`",
		},
		{
			id: "blk1",
			kind: "blocking",
			ts: now - 4 * MIN,
			blocking: {
				kind: "plan_approval",
				eventId: "evt-plan",
				title: "Plan ready — atomic undo (PLAN-338)",
				itemId: "PLAN-338",
				planSummary: "B: session-unified edit log\nC: commit-awareness guard\n+ TUI /history + Team Chat panel",
				selectorOptions: ["Approve", "Revise", "Reject"],
			},
		},
		{
			id: "ask1",
			kind: "ask",
			ts: now - 3 * MIN,
			ask: {
				questionId: "ask-1",
				fromTaskId: "worker-k2",
				status: "answered",
				question: "Decline-by-default, or auto-force committed reverts?",
				answer: "Decline by default; force is an explicit override.",
			},
		},
		{ id: "u2", kind: "user", ts: now - MIN, text: "Looks great. Commit it." },
		{
			id: "fin",
			kind: "assistant",
			ts: now - 30_000,
			text: "Committed as d3c3226. The session-unified log, commit guard, and Team Chat history panel are all in.",
		},
	];
}

function sampleSummaries(now: number): SessionSummary[] {
	return [
		{
			sessionId: "demo-core",
			kind: "spawned",
			pid: 4821,
			cwd: "/home/user/code/ora/spell",
			mode: "code",
			startedAt: now - 18 * MIN,
			projectName: "spell",
			lastHeartbeat: now - 2000,
		},
		{
			sessionId: "demo-web",
			kind: "spawned",
			pid: 4822,
			cwd: "/home/user/code/ora/agentmaker",
			mode: "code",
			startedAt: now - 42 * MIN,
			projectName: "agentmaker",
			lastHeartbeat: now - 9000,
			currentBlockingEvent: {
				kind: "ask",
				eventId: "evt-1",
				questions: [{ id: "q", question: "Which migration strategy?", options: [{ label: "fold-in" }, { label: "fresh" }] }],
			},
		},
		{
			sessionId: "demo-ext",
			kind: "external",
			pid: 5099,
			cwd: "/home/user/code/ora/pi-runtime",
			mode: "code",
			startedAt: now - 90 * MIN,
			projectName: "pi-runtime",
			lastHeartbeat: now - 30_000,
		},
	];
}

/** The edit-history payload the demo's `onEditHistory` handler returns. */
export function demoEditHistory(): EditHistoryResult {
	const nowSec = Math.floor(Date.now() / 1000);
	return {
		entries: [
			{ id: "42", file: "/home/user/code/ora/spell/packages/core/src/registry.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g7", reverted: false, committed: false, commit: null, agentLabel: "main", timestamp: nowSec - 14 * 60 },
			{ id: "41", file: "/home/user/code/ora/spell/packages/core/src/index.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g7", reverted: false, committed: false, commit: null, agentLabel: "main", timestamp: nowSec - 14 * 60 },
			{ id: "40", file: "/home/user/code/ora/spell/packages/core/src/store.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g6", reverted: false, committed: true, commit: "a1b2c3d", agentLabel: "main", timestamp: nowSec - 22 * 60 },
		],
		total: 3,
		undoable: 2,
		redoable: 0,
	};
}

/**
 * Seed the live store so the real Shell renders offline. Returns the synthetic
 * identity used (App.svelte sets `token` to enter the Shell branch).
 */
export function seedDemo(): void {
	const now = Date.now();
	app.setAll(sampleSummaries(now));
	app.wsStatus = "auth_ok";
	app.identity = "demo@local";
	const core = app.sessions.get("demo-core");
	if (core) {
		core.bubbles = sampleBubbles(now);
		core.busy = false;
	}
	app.select("demo-core");
}
