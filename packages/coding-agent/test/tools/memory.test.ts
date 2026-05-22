import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const realNatives = await import("@oh-my-pi/pi-natives");
const realExecuteOrg = realNatives.executeOrg;
// Default to delegating to the real binding so sibling test files (running in
// the same bun:test process) keep working when this module's mock leaks.
const mockExecuteOrg = mock((opts: Parameters<typeof realExecuteOrg>[0]) => realExecuteOrg(opts));
mock.module("@oh-my-pi/pi-natives", () => ({
	...realNatives,
	executeOrg: mockExecuteOrg,
}));

const { dispatchMemoryAction, formatMemoryResult, MemoryTool, memorySchema } = await import("../../src/tools/memory");
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
	// Clear call history + once-queued returns; preserve the real-binding fallback
	// implementation so sibling test files keep working when this mock leaks.
	mockExecuteOrg.mockClear();
	mockExecuteOrg.mockImplementation(opts => realExecuteOrg(opts));
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
				include_personal: true,
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

	it("about returns {node, neighbors[], lineage[]} agent-facing shape", async () => {
		mockExecuteOrg.mockReturnValueOnce(
			ok({
				nodes: [
					{ id: "CON-x", kind: "concept", title: "Seed" },
					{ id: "EP-1", kind: "episode", title: "Source" },
					{ id: "CON-old", kind: "concept", title: "Older" },
				],
				edges: [
					{ from: "CON-x", to: "EP-1", kind: "DISTILLED_FROM" },
					{ from: "CON-x", to: "CON-old", kind: "SUPERSEDES" },
					{ from: "EP-1", to: "CON-x", kind: "ABOUT" },
				],
			}),
		);
		const out = (await dispatchMemoryAction({ action: "about", id: "CON-x" }, repoRoot)) as {
			node: { id: string; kind?: string; title?: string };
			neighbors: Array<{ id: string; kind: string; via: "in" | "out" }>;
			lineage: string[];
		};
		const [args] = calls();
		expect(args.command).toBe("subgraph");
		expect(args.root).toBe("CON-x");
		expect(args.hops).toBe(1);
		expect(out.node).toEqual({ id: "CON-x", kind: "concept", title: "Seed" });
		expect(out.neighbors).toEqual([
			{ id: "EP-1", kind: "DISTILLED_FROM", via: "out" },
			{ id: "CON-old", kind: "SUPERSEDES", via: "out" },
			{ id: "EP-1", kind: "ABOUT", via: "in" },
		]);
		expect(out.lineage).toEqual(["EP-1", "CON-old"]);
	});

	it("about throws without id or focus", async () => {
		await expect(dispatchMemoryAction({ action: "about" }, repoRoot)).rejects.toThrow("requires `id`");
		expect(mockExecuteOrg).not.toHaveBeenCalled();
	});

	it("neighbors routes to subgraph with kinds filter", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ nodes: [], edges: [] }));
		await dispatchMemoryAction({ action: "neighbors", focus: "CON-root", hops: 2, kinds: ["INVOLVED"] }, repoRoot);
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
				text: "Debugged auth flow",
				about: ["CON-oauth"],
				involved: ["FEAT-001"],
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
				kind: "concept",
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

	it("save throws without kind", async () => {
		await expect(dispatchMemoryAction({ action: "save", title: "x" }, repoRoot)).rejects.toThrow("requires `kind`");
	});

	it("link routes to executeOrg(link, ...)", async () => {
		mockExecuteOrg.mockReturnValueOnce(ok({ revision: 1, file: "/x/y.org" }));
		const out = (await dispatchMemoryAction({ action: "link", from: "A", to: "B", kind: "INVOLVED" }, repoRoot)) as {
			revision: number;
		};
		expect(out.revision).toBe(1);
		const [args] = calls();
		expect(args.command).toBe("link");
		expect(args.from).toBe("A");
		expect(args.to).toBe("B");
		expect(args.kind).toBe("INVOLVED");
	});

	it("link throws on missing fields", async () => {
		await expect(dispatchMemoryAction({ action: "link", from: "A", to: "B" }, repoRoot)).rejects.toThrow(
			"requires `from`, `to`, and `kind`",
		);
	});

	it("since with empty memory dir returns no modified entries", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mem-since-empty-"));
		try {
			const out = (await dispatchMemoryAction({ action: "since", ts: "2026-05-21T00:00:00Z" }, tmp)) as {
				added: unknown[];
				modified: unknown[];
				deleted: unknown[];
				note: string;
				ts: string;
			};
			expect(out.added).toEqual([]);
			expect(out.modified).toEqual([]);
			expect(out.deleted).toEqual([]);
			expect(out.note).toContain("PLAN-310 W7");
			expect(out.ts).toBe("2026-05-21T00:00:00Z");
			expect(mockExecuteOrg).not.toHaveBeenCalled();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("since returns concepts modified after the timestamp", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mem-since-real-"));
		try {
			const conceptsDir = path.join(tmp, ".spell", "memory", "concepts");
			const episodesDir = path.join(tmp, ".spell", "memory", "episodes");
			await fs.mkdir(conceptsDir, { recursive: true });
			await fs.mkdir(episodesDir, { recursive: true });

			// Older file (well before ts): should not appear.
			const stale = path.join(conceptsDir, "stale.org");
			await Bun.write(stale, "** ITEM Stale\n:PROPERTIES:\n:CUSTOM_ID: CON-stale\n:END:\n");
			await fs.utimes(stale, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));

			// Newer file: should appear.
			const fresh = path.join(conceptsDir, "fresh.org");
			await Bun.write(fresh, "** ITEM Fresh\n:PROPERTIES:\n:CUSTOM_ID: CON-fresh\n:END:\n");
			await fs.utimes(fresh, new Date("2026-05-22T10:00:00Z"), new Date("2026-05-22T10:00:00Z"));

			// File without :CUSTOM_ID:: id derived from filename.
			const nodrawer = path.join(episodesDir, "2026-05-22.org");
			await Bun.write(nodrawer, "#+TITLE: Episodes 2026-05-22\n");
			await fs.utimes(nodrawer, new Date("2026-05-22T11:00:00Z"), new Date("2026-05-22T11:00:00Z"));

			const out = (await dispatchMemoryAction({ action: "since", ts: "2026-05-21T00:00:00Z" }, tmp)) as {
				modified: Array<{ id: string; file: string; mtime: string }>;
				note: string;
			};

			expect(out.modified.map(m => m.id)).toEqual(["CON-fresh", "EP-2026-05-22"]);
			expect(out.note).not.toContain("not yet implemented");
			expect(mockExecuteOrg).not.toHaveBeenCalled();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("since with future timestamp returns empty modified array", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mem-since-future-"));
		try {
			const conceptsDir = path.join(tmp, ".spell", "memory", "concepts");
			await fs.mkdir(conceptsDir, { recursive: true });
			await Bun.write(path.join(conceptsDir, "x.org"), ":CUSTOM_ID: CON-x\n");
			const out = (await dispatchMemoryAction({ action: "since", ts: "2099-01-01T00:00:00Z" }, tmp)) as {
				modified: unknown[];
			};
			expect(out.modified).toEqual([]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("propagates native error.output as Error.message", async () => {
		mockExecuteOrg.mockReturnValueOnce(err("ITEM_NOT_FOUND: CON-x"));
		await expect(dispatchMemoryAction({ action: "about", id: "CON-x" }, repoRoot)).rejects.toThrow(
			"ITEM_NOT_FOUND: CON-x",
		);
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
		expect(Value.Check(memorySchema, { action: "save", kind: "concept", title: "t" })).toBe(true);
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

	it("formats neighbors-shaped results for neighbors", () => {
		const out = formatMemoryResult({ nodes: [{ id: "A" }, { id: "B" }], edges: [{}] }, "neighbors");
		expect(out).toContain("nodes: 2");
		expect(out).toContain("edges: 1");
	});

	it("formats about-shaped results with node, neighbors, lineage", () => {
		const out = formatMemoryResult(
			{
				node: { id: "CON-x", kind: "concept", title: "Seed" },
				neighbors: [{ id: "EP-1", kind: "DISTILLED_FROM", via: "out" }],
				lineage: ["EP-1"],
			},
			"about",
		);
		expect(out).toContain("node: CON-x Seed");
		expect(out).toContain("neighbors: 1");
		expect(out).toContain("EP-1");
		expect(out).toContain("lineage: EP-1");
	});

	it("formats save/note response with id+file+kind", () => {
		const out = formatMemoryResult({ id: "EP-1", file: "/x.org", kind: "episode" }, "note");
		expect(out).toContain("id: EP-1");
		expect(out).toContain("file: /x.org");
	});
});
