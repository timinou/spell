import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OrgProtocolHandler } from "../../src/internal-urls/org-protocol";
import type { InternalUrl } from "../../src/internal-urls/types";

// Minimal Settings mock.
function makeSettings(enabled: boolean) {
	return {
		get: (key: string) => {
			if (key === "org.enabled") return enabled;
			if (key === "org.todoKeywords") return ["TODO", "DONE", "DOING"];
			if (key === "org.dirs") return undefined;
			return undefined;
		},
	} as unknown as import("../../src/config/settings").Settings;
}

function makeUrl(itemId: string): InternalUrl {
	const raw = `org://${itemId}`;
	const parsed = new URL(raw) as InternalUrl;
	parsed.rawHost = itemId;
	return parsed;
}

describe("OrgProtocolHandler", () => {
	let tmpDir: string;
	let getCwd: () => string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "org-protocol-test-"));
		getCwd = () => tmpDir;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("throws when org is disabled", async () => {
		const handler = new OrgProtocolHandler({ getSettings: () => makeSettings(false), getCwd });
		await expect(handler.resolve(makeUrl("PLAN-001-foo"))).rejects.toThrow("org:// URLs require org to be enabled");
	});

	it("throws when item ID is missing", async () => {
		const handler = new OrgProtocolHandler({ getSettings: () => makeSettings(true), getCwd });
		const url = makeUrl("");
		await expect(handler.resolve(url)).rejects.toThrow("org:// URL requires an item ID");
	});

	it("throws when item is not found", async () => {
		const handler = new OrgProtocolHandler({ getSettings: () => makeSettings(true), getCwd });
		await expect(handler.resolve(makeUrl("NONEXISTENT-001-missing"))).rejects.toThrow(
			"Org item not found: NONEXISTENT-001-missing",
		);
	});
});
