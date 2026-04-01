import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectDomain } from "../../src/domain/detection";

describe("detectDomain", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-domain-detect-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers the CLI override over workspace detection", async () => {
		await Bun.write(path.join(tempDir, ".spell", "domain.json"), JSON.stringify({ domain: "coding" }));

		expect(await detectDomain(tempDir, "growth")).toBe("growth");
	});

	it("reads the workspace override file when present", async () => {
		await Bun.write(path.join(tempDir, ".spell", "domain.json"), JSON.stringify({ domain: "growth" }));

		expect(await detectDomain(tempDir)).toBe("growth");
	});

	it("fails fast on invalid JSON in the workspace override file", async () => {
		await Bun.write(path.join(tempDir, ".spell", "domain.json"), "{");

		await expect(detectDomain(tempDir)).rejects.toThrow("Invalid domain override file");
	});

	it("fails fast when the workspace override file omits the domain field", async () => {
		await Bun.write(path.join(tempDir, ".spell", "domain.json"), JSON.stringify({ wrong: true }));

		await expect(detectDomain(tempDir)).rejects.toThrow("expected a non-empty string field 'domain'");
	});

	it("falls back to the growth heuristic when a growth domain directory exists", async () => {
		await fs.mkdir(path.join(tempDir, "domain", "growth"), { recursive: true });

		expect(await detectDomain(tempDir)).toBe("growth");
	});

	it("falls back to coding when no override or growth directory exists", async () => {
		expect(await detectDomain(tempDir)).toBe("coding");
	});
});
