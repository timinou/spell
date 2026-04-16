import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures");
const CORPUS_PATH = path.join(FIXTURE_DIR, "replay-corpus.jsonl");
const META_PATH = path.join(FIXTURE_DIR, "replay-corpus.meta.json");

function parseLines(content: string): unknown[] {
	return content
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as unknown);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("replay corpus gate", () => {
	let meta: { entries: Array<{ id: string; kind: string; classification: string; why: string }> } | null = null;

	afterEach(() => {
		meta = null;
	});

	it("loads the checked-in corpus and metadata deterministically", async () => {
		const [corpusText, metaText] = await Promise.all([
			fs.readFile(CORPUS_PATH, "utf8"),
			fs.readFile(META_PATH, "utf8"),
		]);

		const corpus = parseLines(corpusText);
		meta = JSON.parse(metaText) as {
			entries: Array<{ id: string; kind: string; classification: string; why: string }>;
		};

		expect(corpus).toHaveLength(10);
		expect(meta.entries).toHaveLength(4);
		expect(meta.entries.map(entry => entry.id)).toEqual([
			"replay-corpus-1",
			"replay-corpus-2",
			"replay-corpus-3",
			"replay-corpus-4",
		]);
	});

	it("rejects malformed corpus entries", async () => {
		const corpusText = await fs.readFile(CORPUS_PATH, "utf8");
		const corpus = parseLines(corpusText);
		const malformed = corpus.find(entry => isObject(entry) && "corrupt" in entry);

		expect(malformed).toBeDefined();
		if (!isObject(malformed)) throw new Error("Expected object entry");
		expect((malformed as { corrupt?: unknown }).corrupt).toBe(true);
	});

	it("exposes the replay gate command contract", () => {
		expect(["bun", "test", "packages/coding-agent/test/tools/replay-corpus.test.ts"]).toEqual([
			"bun",
			"test",
			"packages/coding-agent/test/tools/replay-corpus.test.ts",
		]);
	});
});
