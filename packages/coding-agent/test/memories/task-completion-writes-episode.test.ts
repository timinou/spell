/**
 * Integration: org item state-transition to DONE auto-emits a memory episode
 * via executeOrg(remember, ...). PLAN-310 W7 task-completion producer.
 *
 * The org tool is exercised end-to-end against a temp project root; assertions
 * verify (a) the episode file lands in `.spell/memory/episodes/<date>.org`,
 * (b) re-running the same DONE transition is fingerprint-deduped, (c) items
 * without completion content do not emit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "@spell/pi-org";
import type { OrgConfig } from "@spell/pi-org/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

function makeConfig(): OrgConfig {
	return {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					feat: { prefix: "FEAT", path: "feat" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-completion-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function listEpisodes(): Promise<string[]> {
	const dir = path.join(tmpDir, ".spell", "memory", "episodes");
	try {
		return (await fs.readdir(dir)).filter(n => n.endsWith(".org"));
	} catch {
		return [];
	}
}

async function readEpisodes(): Promise<string> {
	const names = await listEpisodes();
	const parts: string[] = [];
	for (const name of names) {
		parts.push(await Bun.file(path.join(tmpDir, ".spell", "memory", "episodes", name)).text());
	}
	return parts.join("\n");
}

describe("org update → DONE auto-emits episode", () => {
	test("writes an episode with completion content", async () => {
		const tool = createOrgTool(tmpDir, makeConfig());

		const created = (await tool.execute({
			command: "create",
			category: "feat",
			title: "Add structured retries",
		})) as { success: true; id: string; file: string };
		expect(created.success).toBe(true);

		// Seed completion content via the note path so the body has NOTE lines.
		await tool.execute({
			command: "note",
			id: created.id,
			note: "Implemented exponential backoff with jitter; covered by 6 new tests.",
		});

		// Transition to DONE.
		const done = (await tool.execute({
			command: "update",
			id: created.id,
			state: "DONE",
		})) as { success: boolean };
		expect(done.success).toBe(true);

		const episodesText = await readEpisodes();
		expect(episodesText).toContain("Add structured retries");
		expect(episodesText).toContain("exponential backoff");
	});

	test("re-running the same DONE transition is fingerprint-deduped", async () => {
		const tool = createOrgTool(tmpDir, makeConfig());
		const created = (await tool.execute({
			command: "create",
			category: "feat",
			title: "Dedup test",
		})) as { id: string };
		await tool.execute({
			command: "note",
			id: created.id,
			note: "Did the thing.",
		});
		await tool.execute({ command: "update", id: created.id, state: "DONE" });
		const first = await listEpisodes();
		expect(first.length).toBeGreaterThan(0);
		const firstBody = await readEpisodes();
		const firstCount = (firstBody.match(/Dedup test/g) ?? []).length;
		expect(firstCount).toBeGreaterThan(0);

		// Re-emit DONE — should not append a second episode block for the same content.
		await tool.execute({ command: "update", id: created.id, state: "DONE" });
		const secondBody = await readEpisodes();
		const secondCount = (secondBody.match(/Dedup test/g) ?? []).length;
		expect(secondCount).toBe(firstCount);
	});

	test("DONE with no completion content does not emit", async () => {
		const tool = createOrgTool(tmpDir, makeConfig());
		const created = (await tool.execute({
			command: "create",
			category: "feat",
			title: "Empty",
		})) as { id: string };
		await tool.execute({ command: "update", id: created.id, state: "DONE" });
		const episodes = await listEpisodes();
		expect(episodes).toEqual([]);
	});
});
