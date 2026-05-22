import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockExecuteOrg = mock();

const realNatives = await import("@oh-my-pi/pi-natives");
mock.module("@oh-my-pi/pi-natives", () => ({
	...realNatives,
	executeOrg: mockExecuteOrg,
}));

const { dispatchMemoryAction, formatMemoryResult, MemoryTool, memorySchema } = await import(
	"../../src/tools/memory"
);
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
import { Value } from "@sinclair/typebox/value";
import type { ToolSession } from "../../src/tools";

function ok<T>(output: T): { error: false; output: T } {
	return { error: false, output };
}

function err(message: string): { error: true; output: string } {
	return { error: true, output: message };
}

function calls() {
	return mockExecuteOrg.mock.calls.map(call => call[0] as Record<string, unknown>);
}

beforeEach(() => {
	mockExecuteOrg.mockReset();
});

describe("dispatchMemoryAction", () => {
	const repoRoot = "/tmp/repo";

	it("search routes to executeOrg(recall, ...)", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ hits: [{ id: "FEAT-001", score: 0.9 }] }));
		const result = (await dispatchMemoryAction(
			{
				action: "search",
				text: "OAuth2",
				scope: ["concept"],
				hops: 1,
				limit: 5,
				profile: "session-start",
				includePersonal: true,
			},
			repoRoot,
		)) as { hits: unknown[] };

		expect(result.hits).toHaveLength(1);
		const [args] = calls();
		expect(args.command).toBe("recall");
		expect(args.text).toBe("OAuth2");
		expect(args.scope).toEqual(["concept"]);
		expect(args.graphHops).toBe(1);
		expect(args.limit).toBe(5);
		expect(args.profile).toBe("session-start");
		expect(args.includePersonal).toBe(true);
		expect(args.repoRoot).toBe(repoRoot);
	});

	it("about routes to subgraph with hops=1", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ nodes: [{ id: "CON-x" }], edges: [] }));
		await dispatchMemoryAction({ action: "about", id: "CON-x" }, repoRoot);
		const [args] = calls();
		expect(args.command).toBe("subgraph");
		expect(args.root).toBe("CON-x");
		expect(args.hops).toBe(1);
	});

	it("about throws without id or focus", async () => {
		await expect(dispatchMemoryAction({ action: "about" }, repoRoot)).rejects.toThrow("requires `id`");
		expect(mockExecuteOrg).not.toHaveBeenCalled();
	});

	it("neighbors routes to subgraph with kinds filter", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ nodes: [], edges: [] }));
		await dispatchMemoryAction(
			{ action: "neighbors", focus: "CON-root", hops: 2, kinds: ["INVOLVED"] },
			repoRoot,
		);
		const [args] = calls();
		expect(args.command).toBe("subgraph");
		expect(args.root).toBe("CON-root");
		expect(args.hops).toBe(2);
		expect(args.kinds).toEqual(["INVOLVED"]);
	});

	it("neighbors falls back to id when focus is missing", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ nodes: [], edges: [] }));
		await dispatchMemoryAction({ action: "neighbors", id: "CON-fallback" }, repoRoot);
		const [args] = calls();
		expect(args.root).toBe("CON-fallback");
		expect(args.hops).toBe(1); // default
	});

	it("note routes to remember(kind=episode)", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ id: "EP-001", file: "/x/y.org" }));
		await dispatchMemoryAction(
			{
				action: "note",
				note_text: "Debugged auth flow",
				note_about: ["CON-oauth"],
				note_involved: ["FEAT-001"],
			},
			repoRoot,
		);
		const [args] = calls();
		expect(args.command).toBe("remember");
		expect(args.kind).toBe("episode");
		expect(args.summary).toBe("Debugged auth flow");
		expect(args.about).toEqual(["CON-oauth"]);
		expect(args.involves).toEqual(["FEAT-001"]);
	});

	it("save routes to remember with title+body and relation buckets", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ id: "CON-jwt", file: "/x/y.org" }));
		await dispatchMemoryAction(
			{
				action: "save",
				save_kind: "concept",
				title: "JWT Validation",
				body: "Use ES256 keys.",
				distilled_from: ["EP-001"],
				relations: [
					{ kind: "ABOUT", target: "CON-auth" },
					{ kind: "INVOLVED", target: "FEAT-099" },
					{ kind: "PRODUCED", target: "PB-jwt" },
					{ kind: "SUPERSEDES", target: "CON-old-jwt" },
				],
			},
			repoRoot,
		);
		const [args] = calls();
		expect(args.command).toBe("remember");
		expect(args.kind).toBe("concept");
		expect(args.summary).toBe("JWT Validation\n\nUse ES256 keys.");
		expect(args.distilledFrom).toEqual(["EP-001"]);
		expect(args.about).toEqual(["CON-auth"]);
		expect(args.involves).toEqual(["FEAT-099"]);
		expect(args.produced).toEqual(["PB-jwt"]);
		expect(args.supersedes).toEqual(["CON-old-jwt"]);
	});

	it("save throws without save_kind", async () => {
		await expect(
			dispatchMemoryAction({ action: "save", title: "x" }, repoRoot),
		).rejects.toThrow("requires `save_kind`");
	});

	it("link routes to executeOrg(link, ...)", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ revision: 1, file: "/x/y.org" }));
		const out = (await dispatchMemoryAction(
			{ action: "link", from: "A", to: "B", link_kind: "INVOLVED" },
			repoRoot,
		)) as { revision: number };
		expect(out.revision).toBe(1);
		const [args] = calls();
		expect(args.command).toBe("link");
		expect(args.from).toBe("A");
		expect(args.to).toBe("B");
		expect(args.kind).toBe("INVOLVED");
	});

	it("link throws on missing fields", async () => {
		await expect(
			dispatchMemoryAction({ action: "link", from: "A", to: "B" }, repoRoot),
		).rejects.toThrow("requires `from`, `to`, and `link_kind`");
	});

	it("since returns the W7 stub without calling executeOrg", async () => {
		const out = (await dispatchMemoryAction(
			{ action: "since", ts: "2026-05-21T00:00:00Z" },
			repoRoot,
		)) as { added: unknown[]; modified: unknown[]; deleted: unknown[]; note: string; ts: string };
		expect(out.added).toEqual([]);
		expect(out.modified).toEqual([]);
		expect(out.deleted).toEqual([]);
		expect(out.note).toContain("not yet implemented");
		expect(out.ts).toBe("2026-05-21T00:00:00Z");
		expect(mockExecuteOrg).not.toHaveBeenCalled();
	});

	it("propagates native error.output as Error.message", async () => {
		mockExecuteOrg.mockReturnValueOnce(err("ITEM_NOT_FOUND: CON-x"));
		await expect(
			dispatchMemoryAction({ action: "about", id: "CON-x" }, repoRoot),
		).rejects.toThrow("ITEM_NOT_FOUND: CON-x");
	});
});

describe("MemoryTool wiring", () => {
	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "test-session",
			settings: Settings.isolated(),
		};
	}

	it("declares the action union in its schema", () => {
		expect(Value.Check(memorySchema, { action: "search", text: "x" })).toBe(true);
		expect(Value.Check(memorySchema, { action: "save", save_kind: "concept", title: "t" })).toBe(true);
		expect(Value.Check(memorySchema, { action: "nope" })).toBe(false);
	});

	it("MemoryTool.execute returns an error envelope on dispatch failure", async () => {
		mockExecuteOrg.mockReturnValueOnce(err("boom"));
		const tool = new MemoryTool(createSession());
		const result = await tool.execute("call-1", { action: "search", text: "boom" });
		expect(result.details?.error).toBe(true);
		const text = result.content.map(c => (c as { text?: string }).text ?? "").join("");
		expect(text).toContain("boom");
	});

	it("MemoryTool.execute formats search hits as compact line summary", async () => {
		mockExecuteOrg.mockReturnValueOnce(
			ok({
				hits: [
					{ id: "CON-a", score: 0.92, title: "Alpha" },
					{ id: "CON-b", score: 0.81, title: "Beta" },
				],
			}),
		);
		const tool = new MemoryTool(createSession());
		const result = await tool.execute("call-2", { action: "search", text: "x" });
		const text = result.content.map(c => (c as { text?: string }).text ?? "").join("");
		expect(text).toContain("hits: 2");
		expect(text).toContain("CON-a");
		expect(text).toContain("Alpha");
	});
});

describe("formatMemoryResult", () => {
	it("formats since stub with all-zero counters", () => {
		const out = formatMemoryResult({ added: [], modified: [], deleted: [], note: "n" }, "since");
		expect(out).toContain("added: 0");
		expect(out).toContain("note: n");
	});

	it("formats subgraph-like results for about/neighbors", () => {
		const out = formatMemoryResult({ nodes: [{ id: "A" }, { id: "B" }], edges: [{}] }, "about");
		expect(out).toContain("nodes: 2");
		expect(out).toContain("edges: 1");
	});

	it("formats save/note response with id+file+kind", () => {
		const out = formatMemoryResult({ id: "EP-1", file: "/x.org", kind: "episode" }, "note");
		expect(out).toContain("id: EP-1");
		expect(out).toContain("file: /x.org");
	});
});
