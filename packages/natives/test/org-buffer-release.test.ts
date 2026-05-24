import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const require_ = createRequire(import.meta.url);
const nativesDir = path.join(import.meta.dir, "..", "native");
const releaseBinary = fs
	.readdirSync(nativesDir)
	.find(name => name.startsWith("pi_natives.") && name.endsWith(".node") && !name.includes(".dev."));

if (!releaseBinary) {
	throw new Error(`No release native addon found in ${nativesDir}`);
}

const native = require_(path.join(nativesDir, releaseBinary)) as {
	executeOrg(options: Record<string, unknown>): Promise<{ output: unknown; error: boolean }>;
};

function executeOrg(options: Record<string, unknown>): Promise<{ output: unknown; error: boolean }> {
	return native.executeOrg(options);
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "org-release-test-"));
});

afterEach(async () => {
	await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("executeOrg release addon parity", () => {
	it("supports createItem", async () => {
		const filePath = path.join(tempDir, "created.org");
		const result = await executeOrg({
			command: "createItem",
			file: filePath,
			id: "BUG-001",
			title: "Release parity",
			state: "ITEM",
			body: "body",
		});
		expect(result.error).toBe(false);
		expect(fsp.readFile(filePath, "utf8")).resolves.toContain("#+CUSTOM_ID: BUG-001");
	});

	it("supports file-based parse", async () => {
		const filePath = path.join(tempDir, "parse.org");
		await fsp.writeFile(filePath, "* ITEM Parse me\n:PROPERTIES:\n:CUSTOM_ID: BUG-002\n:END:\n\nBody\n");
		const result = await executeOrg({ command: "parse", file: filePath, todoKeywords: ["ITEM", "DONE"] });
		expect(result.error).toBe(false);
		const output = result.output as { items: Array<{ id: string; title: string }> };
		expect(output.items).toHaveLength(1);
		expect(output.items[0]).toMatchObject({ id: "BUG-002", title: "Parse me" });
	});
});
