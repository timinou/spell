import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { SessionRegistryEntry } from "../../../src/socket/session-registry";
import type { WebConnectionData } from "../../../src/web/ws/connection";
import type { WsServerMessage } from "../../../src/web/ws/protocol";
import { WebSubsystem, type WebRoutesDeps } from "../../../src/web/ws/server";

const HEADER = JSON.stringify({ type: "session", id: "s", timestamp: "2026-06-06T12:00:00.000Z", cwd: "/x" });
function msg(message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "2026-06-06T13:00:00.000Z", message });
}

/** Collect everything sent down a fake socket as parsed server messages. */
function makeFakeSocket(sink: WsServerMessage[]): ServerWebSocket<WebConnectionData> {
	return {
		data: { identity: { name: "tester" } },
		send(raw: string) {
			sink.push(JSON.parse(raw) as WsServerMessage);
		},
		close() {},
	} as unknown as ServerWebSocket<WebConnectionData>;
}

interface Harness {
	subsystem: WebSubsystem;
	sink: WsServerMessage[];
	deliver: (frame: unknown) => Promise<void>;
	open: () => void;
}

function makeHarness(opts: {
	entry?: SessionRegistryEntry;
	hubRoot?: string;
}): Harness {
	const sink: WsServerMessage[] = [];
	const eventTaps = new Set<unknown>();

	const deps = {
		registry: {
			getSession: (_id: string) => opts.entry,
			getRecentLog: () => [],
			onSessionChange() {},
			onBlockingEvent() {},
			onBlockingEventCleared() {},
			onEventLog() {},
		},
		hub: {
			getSessionRoot: (_id: string) => opts.hubRoot,
			subscribeEvents: () => {
				const t = {};
				eventTaps.add(t);
				return () => eventTaps.delete(t);
			},
			subscribeStderr: () => () => undefined,
			onLifecycle() {},
			onProcessInfo() {},
		},
		watcher: { watch() {}, unwatch() {}, onCreated() {} },
	} as unknown as WebRoutesDeps;

	const subsystem = new WebSubsystem(deps);
	const handler = subsystem.websocketHandler();
	const ws = makeFakeSocket(sink);

	return {
		subsystem,
		sink,
		open: () => handler.open?.(ws),
		deliver: async (frame: unknown) => {
			await handler.message?.(ws, JSON.stringify(frame));
		},
	};
}

function entryOf(kind: "external" | "spawned", sessionRoot?: string): SessionRegistryEntry {
	return {
		sessionId: "sess-1",
		kind,
		pid: 1,
		cwd: "/x",
		mode: "rpc",
		startedAt: 0,
		projectName: "x",
		lastHeartbeat: 0,
		sessionRoot,
	};
}

describe("WebSubsystem subscribe → disk backfill", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subscribe-backfill-"));
		file = join(dir, "session.jsonl");
		writeFileSync(file, [HEADER, msg({ role: "user", content: "hi", attribution: "user" }), msg({ role: "assistant", content: [{ type: "text", text: "yo" }] })].join("\n"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function backfillEntries(sink: WsServerMessage[]) {
		return sink.filter((m): m is Extract<WsServerMessage, { type: "external_event_log" }> => m.type === "external_event_log");
	}

	it("backfills an external session from its on-disk JSONL", async () => {
		// sessionRoot is the artifacts dir; the JSONL is `${root}.jsonl`.
		const root = file.slice(0, -6); // strip .jsonl
		const h = makeHarness({ entry: entryOf("external", root) });
		h.open();
		await h.deliver({ type: "subscribe", sessionId: "sess-1", channels: ["events"] });

		const entries = backfillEntries(h.sink).map(m => m.entry);
		expect(entries.map(e => e.kind)).toEqual(["user_message", "assistant_text"]);
		expect(entries[1]).toMatchObject({ text: "yo" });
	});

	it("backfills a spawned session via hub.getSessionRoot", async () => {
		const root = file.slice(0, -6);
		const h = makeHarness({ entry: entryOf("spawned"), hubRoot: root });
		h.open();
		await h.deliver({ type: "subscribe", sessionId: "sess-1", channels: ["events"] });

		expect(backfillEntries(h.sink).map(m => m.entry.kind)).toEqual(["user_message", "assistant_text"]);
	});

	it("does not replay twice on a redundant resubscribe", async () => {
		const root = file.slice(0, -6);
		const h = makeHarness({ entry: entryOf("external", root) });
		h.open();
		await h.deliver({ type: "subscribe", sessionId: "sess-1", channels: ["events"] });
		const firstCount = backfillEntries(h.sink).length;
		expect(firstCount).toBe(2);

		await h.deliver({ type: "subscribe", sessionId: "sess-1", channels: ["events"] });
		expect(backfillEntries(h.sink).length).toBe(firstCount);
	});

	it("emits no backfill when no transcript is resolvable", async () => {
		const h = makeHarness({ entry: entryOf("external", undefined) });
		h.open();
		await h.deliver({ type: "subscribe", sessionId: "sess-1", channels: ["events"] });
		expect(backfillEntries(h.sink)).toHaveLength(0);
	});
});
