import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayTranscript } from "../../../src/web/session/transcript-replay";

// Build a session JSONL line for a `message` entry.
function messageLine(message: Record<string, unknown>, ts = "2026-06-06T13:00:00.000Z"): string {
	return JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: ts, message });
}

const HEADER = JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-06-06T12:59:00.000Z", cwd: "/x" });

describe("replayTranscript", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "transcript-replay-"));
		file = join(dir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] for a missing file", async () => {
		expect(await replayTranscript(join(dir, "nope.jsonl"))).toEqual([]);
	});

	it("returns [] for an empty file", async () => {
		writeFileSync(file, "");
		expect(await replayTranscript(file)).toEqual([]);
	});

	it("maps user and assistant messages to event log entries in order", async () => {
		const jsonl = [
			HEADER,
			messageLine({ role: "user", content: "hello there", attribution: "user" }),
			messageLine({ role: "assistant", content: [{ type: "text", text: "hi back" }] }),
		].join("\n");
		writeFileSync(file, jsonl);

		const entries = await replayTranscript(file);
		expect(entries).toEqual([
			{ kind: "user_message", ts: Date.parse("2026-06-06T13:00:00.000Z"), text: "hello there" },
			{ kind: "assistant_text", ts: Date.parse("2026-06-06T13:00:00.000Z"), text: "hi back" },
		]);
	});

	it("preserves full assistant text (no clipping)", async () => {
		const long = "x".repeat(5000);
		writeFileSync(file, [HEADER, messageLine({ role: "assistant", content: [{ type: "text", text: long }] })].join("\n"));
		const entries = await replayTranscript(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.text).toBe(long);
	});

	it("emits assistant text then tool_call summaries from one message", async () => {
		writeFileSync(
			file,
			[
				HEADER,
				messageLine({
					role: "assistant",
					content: [
						{ type: "text", text: "let me search" },
						{ type: "toolCall", id: "t1", name: "grep", arguments: {}, intent: "Searching for X" },
					],
				}),
			].join("\n"),
		);
		const entries = await replayTranscript(file);
		expect(entries.map(e => e.kind)).toEqual(["assistant_text", "tool_call"]);
		expect(entries[1]).toMatchObject({ kind: "tool_call", toolName: "grep", text: "Searching for X" });
	});

	it("maps tool results with error meta", async () => {
		writeFileSync(
			file,
			[HEADER, messageLine({ role: "toolResult", toolName: "bash", isError: true, content: [] })].join("\n"),
		);
		const [entry] = await replayTranscript(file);
		expect(entry).toMatchObject({ kind: "tool_result", toolName: "bash", meta: { isError: true } });
	});

	it("drops non-user attributed messages (e.g. synthetic)", async () => {
		writeFileSync(
			file,
			[HEADER, messageLine({ role: "user", content: "system injected", attribution: "agent" })].join("\n"),
		);
		expect(await replayTranscript(file)).toEqual([]);
	});

	it("tolerates a trailing partial line", async () => {
		const jsonl = `${[HEADER, messageLine({ role: "assistant", content: "done" })].join("\n")}\n{"type":"mess`;
		writeFileSync(file, jsonl);
		const entries = await replayTranscript(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "assistant_text", text: "done" });
	});

	it("skips malformed lines truthfully", async () => {
		const jsonl = [HEADER, "not json at all", messageLine({ role: "assistant", content: "ok" })].join("\n");
		writeFileSync(file, jsonl);
		const entries = await replayTranscript(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "assistant_text", text: "ok" });
	});

	it("scans only the byte-budget tail, self-healing a severed first line", async () => {
		const lines = [HEADER];
		for (let i = 0; i < 200; i++) {
			lines.push(messageLine({ role: "assistant", content: `entry-${i}` }));
		}
		writeFileSync(file, lines.join("\n"));
		// Tiny byte budget forces a mid-file tail slice; the severed partial first
		// line must be skipped, not throw, and recent entries still parse.
		const entries = await replayTranscript(file, { maxEntries: 1000, maxBytes: 400 });
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.at(-1)).toMatchObject({ kind: "assistant_text", text: "entry-199" });
	});

	it("bounds output to the most recent N entries in order", async () => {
		const lines = [HEADER];
		for (let i = 0; i < 50; i++) {
			lines.push(messageLine({ role: "assistant", content: `msg-${i}` }));
		}
		writeFileSync(file, lines.join("\n"));
		const entries = await replayTranscript(file, { maxEntries: 10, maxBytes: 1_000_000 });
		expect(entries).toHaveLength(10);
		expect(entries[0]).toMatchObject({ text: "msg-40" });
		expect(entries[9]).toMatchObject({ text: "msg-49" });
	});
});
