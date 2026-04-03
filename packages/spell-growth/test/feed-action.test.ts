import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { sendGrowthFeed } from "../src/actions/feed-send";
import { cleanupTempDir, createTempDir } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupTempDir(dir)));
	tempDirs.clear();
});

describe("feed action", () => {
	it("groups digest content, truncates to telegram limits, and writes an artifact", async () => {
		const dir = await createTempDir("spell-growth-feed-");
		tempDirs.add(dir);
		const result = await sendGrowthFeed({
			outboxDir: dir,
			maxCharacters: 120,
			items: [
				{
					id: "a",
					title: "First",
					summary: "A very long summary about automation and finance teams.",
					canonicalUrl: "https://a",
					personaSlug: "finance",
				},
				{
					id: "b",
					title: "Second",
					summary: "Another long summary about GTM systems.",
					canonicalUrl: "https://b",
					personaSlug: "ops",
				},
			],
		});

		expect(result.messages[0].text.length).toBeLessThanOrEqual(120);
		expect(result.messages[0].replyMarkup.inlineKeyboard[0][0].callbackData).toContain("publish:");
		expect(JSON.parse(await Bun.file(path.join(dir, "feed-digest.json")).text())).toEqual({
			messages: result.messages,
		});
		expect(result.artifactPath).toBe(path.join(dir, "feed-digest.json"));
	});
});
