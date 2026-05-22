import { dispatchMemoryAction } from "../../../tools/memory.js";
import type { MemoryParams } from "../../../tools/memory.js";
import type { MemoryHit } from "./types.js";

export async function memorySearch(
	repoRoot: string,
	text: string,
	opts?: { scope?: string[]; focus?: string; limit?: number; profile?: string },
): Promise<{ hits: MemoryHit[] }> {
	const result = await dispatchMemoryAction(
		{
			action: "search",
			text,
			scope: opts?.scope as MemoryParams["scope"],
			focus: opts?.focus,
			limit: opts?.limit,
			profile: opts?.profile,
		},
		repoRoot,
	);
	const data = result as { hits: MemoryHit[] };
	return { hits: data.hits ?? [] };
}

export async function memoryAbout(
	repoRoot: string,
	id: string,
): Promise<{
	node: { id: string; kind?: string; title?: string } | null;
	neighbors: Array<{ id: string; kind: string; via: "in" | "out" }>;
	lineage: string[];
}> {
	const result = await dispatchMemoryAction({ action: "about", id }, repoRoot);
	const data = result as {
		node: { id: string; kind?: string; title?: string } | null;
		neighbors: Array<{ id: string; kind: string; via: "in" | "out" }>;
		lineage: string[];
	};
	return {
		node: data.node ?? null,
		neighbors: data.neighbors ?? [],
		lineage: data.lineage ?? [],
	};
}

export async function memoryNeighbors(
	repoRoot: string,
	focus: string,
	opts?: { hops?: number; kinds?: string[] },
): Promise<{
	nodes: Array<{ id: string; title?: string; kind?: string }>;
	edges: Array<{ from: string; to: string; kind: string }>;
}> {
	const result = await dispatchMemoryAction(
		{
			action: "neighbors",
			focus,
			hops: opts?.hops,
			kinds: opts?.kinds as MemoryParams["kinds"],
		},
		repoRoot,
	);
	const data = result as {
		nodes: Array<{ id: string; title?: string; kind?: string }>;
		edges: Array<{ from: string; to: string; kind: string }>;
	};
	return {
		nodes: data.nodes ?? [],
		edges: data.edges ?? [],
	};
}

export async function memorySince(
	repoRoot: string,
	ts: string | number,
): Promise<{
	added: Array<{ id: string; file: string; mtime: number }>;
	modified: Array<{ id: string; file: string; mtime: number }>;
	deleted: string[];
	ts: string;
	note?: string;
}> {
	const result = await dispatchMemoryAction({ action: "since", ts }, repoRoot);
	const data = result as {
		added: Array<{ id: string; file: string; mtime: number }>;
		modified: Array<{ id: string; file: string; mtime: number }>;
		deleted: string[];
		ts: string;
		note?: string;
	};
	return {
		added: data.added ?? [],
		modified: data.modified ?? [],
		deleted: data.deleted ?? [],
		ts: data.ts,
		note: data.note,
	};
}
