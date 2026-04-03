import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadDataDirectory, parseDataConfigKdl } from "../../src/config/data-parser";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

describe("parseDataConfigKdl", () => {
	it("parses a single persona with goals, challenges, and keywords", () => {
		const config = parseDataConfigKdl(`persona "pm-leader" name="PM Leader" summary="Drives product outcomes" {
			goal "Increase activation"
			goal "Improve retention"
			challenge "Noisy feedback"
			keyword "activation"
			keyword "retention"
		}`);

		expect(config.personas.get("pm-leader")).toEqual({
			id: "pm-leader",
			name: "PM Leader",
			summary: "Drives product outcomes",
			goals: ["Increase activation", "Improve retention"],
			challenges: ["Noisy feedback"],
			keywords: ["activation", "retention"],
		});
		expect(config.persons.size).toBe(0);
		expect(config.sources.size).toBe(0);
	});

	it("parses a single person with sources", () => {
		const config = parseDataConfigKdl(`person "april-dunford" name="April Dunford" role="Positioning expert" url="https://example.com" {
			source kind="x" value="aprildunford" priority=1
			source kind="rss" value="https://example.com/feed.xml"
		}`);

		expect(config.persons.get("april-dunford")).toEqual({
			id: "april-dunford",
			name: "April Dunford",
			role: "Positioning expert",
			url: "https://example.com",
			sources: [
				{ kind: "x", value: "aprildunford", priority: 1 },
				{ kind: "rss", value: "https://example.com/feed.xml" },
			],
		});
	});

	it("parses a single source", () => {
		const config = parseDataConfigKdl(
			`source "april-blog" label="April Blog" kind="rss" value="https://example.com/feed.xml" priority=3`,
		);

		expect(config.sources.get("april-blog")).toEqual({
			id: "april-blog",
			label: "April Blog",
			kind: "rss",
			value: "https://example.com/feed.xml",
			priority: 3,
		});
	});

	it("parses a combined document with personas, persons, and sources", () => {
		const config = parseDataConfigKdl(`persona "operator" name="Operator" summary="Runs the system" {
			goal "Reduce toil"
		}
		person "elena" name="Elena Verna" {
			source kind="newsletter" value="https://example.com/newsletter"
		}
		source "growth-rss" label="Growth RSS" kind="rss" value="https://example.com/rss" priority=2`);

		expect([...config.personas.keys()]).toEqual(["operator"]);
		expect([...config.persons.keys()]).toEqual(["elena"]);
		expect([...config.sources.keys()]).toEqual(["growth-rss"]);
	});

	it("rejects an unknown top-level node", () => {
		expect(() => parseDataConfigKdl(`widget "unknown"`)).toThrow(/unsupported top-level node "widget"/i);
	});

	it("rejects duplicate persona ids", () => {
		expect(() =>
			parseDataConfigKdl(`persona "same" name="One" summary="First"
			persona "same" name="Two" summary="Second"`),
		).toThrow(/duplicate persona id "same"/i);
	});

	it("rejects duplicate source ids", () => {
		expect(() =>
			parseDataConfigKdl(`source "same" label="One" kind="rss" value="https://one" priority=1
			source "same" label="Two" kind="rss" value="https://two" priority=2`),
		).toThrow(/duplicate source id "same"/i);
	});

	it("parses a persona with no child nodes as empty arrays", () => {
		const config = parseDataConfigKdl(`persona "quiet" name="Quiet" summary="No child nodes"`);

		expect(config.personas.get("quiet")).toEqual({
			id: "quiet",
			name: "Quiet",
			summary: "No child nodes",
			goals: [],
			challenges: [],
			keywords: [],
		});
	});

	it("parses a person with no sources as an empty array", () => {
		const config = parseDataConfigKdl(`person "solo" name="Solo Researcher"`);

		expect(config.persons.get("solo")).toEqual({
			id: "solo",
			name: "Solo Researcher",
			sources: [],
		});
	});
});

describe("loadDataDirectory", () => {
	it("merges multiple kdl files from a directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-data-config-"));
		tempDirs.add(tempDir);

		await fs.writeFile(
			path.join(tempDir, "personas.kdl"),
			`persona "builder" name="Builder" summary="Builds systems" {
				goal "Ship reliable systems"
			}`,
		);
		await fs.writeFile(
			path.join(tempDir, "sources.kdl"),
			`source "builder-rss" label="Builder RSS" kind="rss" value="https://example.com/rss" priority=1`,
		);

		const config = await loadDataDirectory(tempDir);

		expect(config.personas.get("builder")?.goals).toEqual(["Ship reliable systems"]);
		expect(config.sources.get("builder-rss")?.priority).toBe(1);
		expect(config.persons.size).toBe(0);
	});

	it("returns empty maps for an empty directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-data-config-empty-"));
		tempDirs.add(tempDir);

		const config = await loadDataDirectory(tempDir);

		expect(config).toEqual({
			personas: new Map(),
			persons: new Map(),
			sources: new Map(),
		});
	});
});
