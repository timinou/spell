import { describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const require_ = createRequire(import.meta.url);
const nativesDir = path.join(import.meta.dir, "..", "native");
const addonPath = (() => {
	const devPath = path.join(nativesDir, "pi_natives.dev.node");
	if (nodeFs.existsSync(devPath)) return devPath;
	const preferred = nodeFs
		.readdirSync(nativesDir)
		.find(name => name.startsWith("pi_natives.") && name.endsWith(".node") && name !== "pi_natives.dev.node");
	return preferred ? path.join(nativesDir, preferred) : devPath;
})();
const native = require_(addonPath) as {
	executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean };
};

function executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean } {
	return native.executeCodeBuffer(options);
}

async function createRepoTempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(process.cwd(), `${prefix}-`));
}

describe("executeCodeBuffer coord bridge", () => {
	it("rejects mutating edit commands without sessionId", async () => {
		const tempDir = await createRepoTempDir("pi-natives-coord-missing-session");
		const file = path.join(tempDir, "missing-session.ts");
		const result = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const value = 1;\n" }] }],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({
				code: "MISSING_SESSION_ID",
				message: expect.stringContaining("sessionId"),
			}),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("writes coord journal entries through session-attributed save", async () => {
		const tempDir = await createRepoTempDir("pi-natives-coord-save");
		const file = path.join(tempDir, "coord-save.ts");
		const sessionId = "coord-test-session";

		const replace = executeCodeBuffer({
			command: "replace_content",
			file,
			content: "export const value = 1;\n",
			sessionId,
		});
		expect(replace.error).toBe(false);
		const save = executeCodeBuffer({ command: "save", file, sessionId });
		expect(save).toEqual({
			error: false,
			output: expect.objectContaining({ success: true, version: expect.any(Number) }),
		});
		expect(await Bun.file(file).text()).toBe("export const value = 1;\n");

		const status = executeCodeBuffer({ command: "coord_status", file });
		expect(status.error).toBe(false);
		expect(status.output).toEqual(
			expect.objectContaining({
				brokerUp: expect.any(Boolean),
				peers: expect.any(Array),
				socketPath: expect.any(String),
			}),
		);

		const journalTail = executeCodeBuffer({ command: "coord_journal_tail", file, limit: 4 });
		expect(journalTail.error).toBe(false);
		expect(journalTail.output).toEqual(
			expect.objectContaining({
				file,
				entries: expect.arrayContaining([
					expect.objectContaining({
						sessionId,
						kind: "commit",
						revision: expect.any(Number),
						codePaths: expect.any(Array),
					}),
				]),
			}),
		);
		await fs.rm(tempDir, { recursive: true, force: true });
	});
});
