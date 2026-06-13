import { mount } from "svelte";
import Shell from "../src/components/Shell.svelte";
import { app } from "../src/lib/stores.svelte";
import type { ChatBubble } from "../src/lib/reducers";
import type { SessionSummary } from "../src/lib/protocol";
import type { EditHistoryResult } from "../src/lib/protocol";

// A standalone gallery harness that mounts the REAL Shell with a seeded store,
// so screenshots show the assembled Team Chat surface (rail + chat log +
// statusbar) — every bubble kind, including the PLAN-338 edit accents — rather
// than isolated components.

const now = Date.now();
const MIN = 60_000;

const summaries: SessionSummary[] = [
	{
		sessionId: "sess-core",
		kind: "spawned",
		pid: 4821,
		cwd: "/home/user/code/ora/spell",
		mode: "code",
		startedAt: now - 18 * MIN,
		projectName: "spell",
		lastHeartbeat: now - 2,
	},
	{
		sessionId: "sess-web",
		kind: "spawned",
		pid: 4822,
		cwd: "/home/user/code/ora/agentmaker",
		mode: "code",
		startedAt: now - 42 * MIN,
		projectName: "agentmaker",
		lastHeartbeat: now - 9,
		currentBlockingEvent: {
			kind: "ask",
			eventId: "evt-1",
			questions: [{ id: "q", question: "Which migration strategy?", options: [{ label: "fold-in" }, { label: "fresh" }] }],
		},
	},
	{
		sessionId: "sess-ext",
		kind: "external",
		pid: 5099,
		cwd: "/home/user/code/ora/pi-runtime",
		mode: "code",
		startedAt: now - 90 * MIN,
		projectName: "pi-runtime",
		lastHeartbeat: now - 30,
	},
];

const bubbles: ChatBubble[] = [
	{ id: "u1", kind: "user", ts: now - 900, text: "Refactor the Registry class to Store and fix the broken undo." },
	{
		id: "a1",
		kind: "assistant",
		ts: now - 880,
		text: "On it. I'll rename Registry → Store across the core package, then trace the undo regression.",
	},
	{
		id: "t1",
		kind: "tool_start",
		ts: now - 860,
		toolName: "edit",
		args: { target: "packages/core/src/registry.ts::Registry", action: { kind: "rename", to: "Store" } },
	},
	{
		id: "t1b",
		kind: "tool_start",
		ts: now - 859,
		toolName: "find",
		args: { target: "packages/core/src/**/*.ts::§call[name=Registry]" },
	},
	{
		id: "t2",
		kind: "tool_end",
		ts: now - 858,
		toolName: "edit",
		text: "renamed Registry → Store · 3 files, 11 references updated",
	},
	{
		id: "th1",
		kind: "assistant_thinking",
		ts: now - 840,
		text: "The undo reverted a committed file because the recorder used a single global log. Need session scoping + a commit guard.",
	},
	{
		id: "te1",
		kind: "tool_end",
		ts: now - 820,
		toolName: "edit",
		text:
			"undo · packages/core/src/registry.ts\n@@ -1 +1 @@\n-export class Store {\n+export class Registry {\n\nundo · packages/core/src/index.ts\n@@ -3 +3 @@\n-import { Store }\n+import { Registry }",
	},
	{
		id: "te2",
		kind: "tool_end",
		ts: now - 800,
		toolName: "edit",
		text: "redo · packages/core/src/registry.ts\n@@ -1 +1 @@\n-export class Registry {\n+export class Store {",
	},
	{
		id: "te3",
		kind: "tool_end",
		ts: now - 780,
		toolName: "edit",
		text:
			"undo declined: already committed — packages/core/src/store.ts (a1b2c3d)\n  • re-run with force to revert anyway\n  • or use `git revert`",
	},
	{
		id: "blk1",
		kind: "blocking",
		ts: now - 740,
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
		ts: now - 720,
		ask: {
			questionId: "ask-1",
			fromTaskId: "worker-k2",
			status: "answered",
			question: "Decline-by-default, or auto-force committed reverts?",
			answer: "Decline by default; force is an explicit override.",
		},
	},
	{ id: "err1", kind: "error", ts: now - 700, isError: true, text: "PeerConflict: another session committed store.ts first — re-read and retry." },
	{ id: "u2", kind: "user", ts: now - 80, text: "Looks great. Commit it." },
	{
		id: "pend",
		kind: "assistant",
		ts: now - 40,
		text: "Committed as d3c3226. The session-unified log, commit guard, and Team Chat history panel are all in.",
	},
];

app.setAll(summaries);
app.wsStatus = "auth_ok";
app.identity = "alex@team";
app.theme = "dark";
const core = app.sessions.get("sess-core");
if (core) {
	core.bubbles = bubbles;
	core.busy = false;
}
app.select("sess-core");

const editHistory: EditHistoryResult = {
	entries: [
		{ id: "42", file: "/home/user/code/ora/spell/packages/core/src/registry.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g7", reverted: false, committed: false, commit: null, agentLabel: "main", timestamp: Math.floor((now - 14 * MIN) / 1000) },
		{ id: "41", file: "/home/user/code/ora/spell/packages/core/src/index.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g7", reverted: false, committed: false, commit: null, agentLabel: "main", timestamp: Math.floor((now - 14 * MIN) / 1000) },
		{ id: "40", file: "/home/user/code/ora/spell/packages/core/src/store.ts", workspace: "/home/user/code/ora/spell/packages/core", groupId: "g6", reverted: false, committed: true, commit: "a1b2c3d", agentLabel: "main", timestamp: Math.floor((now - 22 * MIN) / 1000) },
	],
	total: 3,
	undoable: 2,
	redoable: 0,
};

const noop = async () => undefined as never;
const props = {
	token: "demo",
	templates: [],
	debugOpen: false,
	onToggleDebug: () => {},
	onSpawn: noop,
	onSubmit: noop,
	onAbort: () => {},
	onKill: noop,
	onRunStored: noop,
	onTileList: noop,
	onTileCreate: noop,
	onTileUpdate: noop,
	onTileRecordRun: noop,
	onTileDelete: noop,
	onEditHistory: async (): Promise<EditHistoryResult> => editHistory,
	onBlockingAction: () => {},
	onSignOut: () => {},
};

const target = document.getElementById("app");
if (target) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mount(Shell, { target, props: props as any });
}
