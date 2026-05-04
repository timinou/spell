import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeLineHash } from "@oh-my-pi/pi-coding-agent/patch";
import { CodepathEditTool, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

const tmpDir = path.join(process.cwd(), "packages/coding-agent/test/tmp-edit");

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: Awaited<ReturnType<CodepathEditTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

async function writeFile(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
}

describe("CodepathEditTool", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
		} catch {}
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true });
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
		} catch {}
	});

	it("performs LINE#ID replace", async () => {
		const file = path.join(tmpDir, "lineid.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n");
		const h2 = computeLineHash(2, "beta");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", pos: `2#${h2}`, lines: ["delta"] },
				},
			],
		});
		expect(getText(result)).toContain("Updated");
		const content = await fs.readFile(file, "utf-8");
		expect(content).toBe("alpha\ndelta\ngamma\n");
	});

	it("appends at EOF via anchorless append", async () => {
		const file = path.join(tmpDir, "append.txt");
		await writeFile(file, "alpha");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "append", lines: ["beta"] } }],
		});
		expect(getText(result)).toContain("Updated");
		const content = await fs.readFile(file, "utf-8");
		expect(content).toBe("alpha\nbeta");
	});

	it("prepends at BOF via anchorless prepend", async () => {
		const file = path.join(tmpDir, "prepend.txt");
		await writeFile(file, "beta");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "prepend", lines: ["alpha"] } }],
		});
		expect(getText(result)).toContain("Updated");
		const content = await fs.readFile(file, "utf-8");
		expect(content).toBe("alpha\nbeta");
	});

	it("dispatches structural rename to executeCodeBuffer", async () => {
		const spy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { editCount: 1 } as any,
			error: false,
		});
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts::oldName",
					action: { kind: "rename", content: "newName" },
				},
			],
		});
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				root: tmpDir,
				operations: [
					expect.objectContaining({
						targetId: path.join(tmpDir, "src/example.ts::oldName"),
						actions: [expect.objectContaining({ kind: "rename", content: "newName" })],
					}),
				],
			}),
		);
	});

	it("surfaces structural edit errors from executeCodeBuffer", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { code: "TARGET_NOT_FOUND", message: "oldName not found" } as any,
			error: true,
		});
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: "src/example.ts::oldName", action: { kind: "rename", content: "newName" } }],
		});
		expect(getText(result)).toContain("oldName not found");
	});

	it("applies patch unified-diff", async () => {
		const file = path.join(tmpDir, "patch.txt");
		await writeFile(file, "line one\nline two\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: {
						kind: "patch",
						diff: `@@ -1,2 +1,2 @@
-line one
+line alpha
 line two`,
					},
				},
			],
		});
		expect(getText(result)).toContain("Updated");
		const content = await fs.readFile(file, "utf-8");
		expect(content).toContain("line alpha");
	});

	it("rejects noop edit without idempotent flag", async () => {
		const file = path.join(tmpDir, "noop.txt");
		await writeFile(file, "same\n");
		const h1 = computeLineHash(1, "same");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", pos: `1#${h1}`, lines: ["same"] },
				},
			],
		});
		expect(getText(result)).toContain("No changes");
		expect(getText(result)).toContain("idempotent=true");
	});

	it("accepts noop edit with idempotent flag", async () => {
		const file = path.join(tmpDir, "noop-ok.txt");
		await writeFile(file, "same\n");
		const h1 = computeLineHash(1, "same");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", pos: `1#${h1}`, lines: ["same"] },
					idempotent: true,
				},
			],
		});
		expect(getText(result)).toContain("No changes (idempotent)");
	});

	it("passes occurrence first to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { editCount: 1 } as any,
			error: false,
		});
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "findAndReplace", find: "foo", content: "bar", occurrence: "first" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.operations[0].actions[0].occurrence).toBe("first");
	});

	it("passes occurrence last to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { editCount: 1 } as any,
			error: false,
		});
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "findAndReplace", find: "foo", content: "bar", occurrence: "last" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.operations[0].actions[0].occurrence).toBe("last");
	});

	it("passes occurrence all to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { editCount: 1 } as any,
			error: false,
		});
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "findAndReplace", find: "foo", content: "bar", occurrence: "all" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.operations[0].actions[0].occurrence).toBe("all");
	});

	it("passes occurrence N to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { editCount: 1 } as any,
			error: false,
		});
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "findAndReplace", find: "foo", content: "bar", occurrence: 3 },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.operations[0].actions[0].occurrence).toBe(3);
	});

	it("returns stale anchor diagnostic for mismatched hash", async () => {
		const file = path.join(tmpDir, "stale.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", pos: "2#ZZ", lines: ["delta"] },
				},
			],
		});
		expect(getText(result)).toContain("changed");
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "edit")).toBe(true);
	});
});
