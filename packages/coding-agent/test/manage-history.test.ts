import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeCodePath } from "@oh-my-pi/pi-natives";

const tmpDir = path.join(process.cwd(), "packages/coding-agent/test/tmp-manage-history");

async function writeFile(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
}

async function tempFile(content: string): Promise<string> {
	const name = `file-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
	const p = path.join(tmpDir, name);
	await writeFile(p, content);
	return p;
}

async function edit(file: string, sessionId: string, find: string, replace: string): Promise<void> {
	const chunks = await executeCodePath({
		command: "edit",
		target: path.relative(tmpDir, file),
		root: tmpDir,
		actions: [
			{
				kind: "rawTextReplace",
				find,
				content: replace,
			},
		],
		sessionId,
	});
	const diagnostics = chunks.flatMap(c => c.diagnostics);
	if (diagnostics.length > 0) {
		throw new Error(diagnostics[0].message);
	}
}

async function manage(manage: string, sessionId: string, file?: string): Promise<any> {
	const chunks = await executeCodePath({
		command: "manage",
		manage,
		target: file ?? "",
		root: tmpDir,
		sessionId,
	});
	const diagnostics = chunks.flatMap(c => c.diagnostics);
	if (diagnostics.length > 0) {
		throw new Error(diagnostics[0].message);
	}
	const node = chunks[0]?.nodes[0];
	return node?.metadata?.payload ?? {};
}

describe("manage history (BUG-340)", () => {
	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("edit auto-saves then manage undo restores", async () => {
		const file = await tempFile("const hello = 1;\n");
		await edit(file, "S1", "hello", "world");
		expect(await fs.readFile(file, "utf8")).toBe("const world = 1;\n");

		await manage("undo", "S1", file);
		expect(await fs.readFile(file, "utf8")).toBe("const hello = 1;\n");
	});

	it("two sessions edit different lines; one undoes, the other survives", async () => {
		const file = await tempFile("const a = 1;\nconst b = 2;\nconst c = 3;\n");

		await edit(file, "S1", "a", "A1");
		await edit(file, "S2", "b", "B2");
		expect(await fs.readFile(file, "utf8")).toBe("const A1 = 1;\nconst B2 = 2;\nconst c = 3;\n");

		await manage("undo", "S1", file);
		expect(await fs.readFile(file, "utf8")).toBe("const a = 1;\nconst B2 = 2;\nconst c = 3;\n");
	});

	it("manage context lists this session's edits", async () => {
		const file = await tempFile("const x = 1;\n");
		await edit(file, "S1", "x", "y");
		await edit(file, "S1", "y", "z");

		const ctx = await manage("context", "S1");
		expect(ctx.entries.length).toBe(2);
		expect(ctx.entries[0].file).toBe(file);
		expect(ctx.entries[0].sessionId).toBe("S1");
	});
});
