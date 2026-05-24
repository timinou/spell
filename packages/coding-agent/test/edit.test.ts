import { afterEach, beforeEach, describe, expect, it, spyOn, test } from "bun:test";
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

function mockEditResult(editCount = 1, created = false, diff?: string): any {
	const metadata: Record<string, unknown> = { editCount, created };
	if (diff !== undefined) metadata.diff = diff;
	return [
		{
			nodes: [
				{
					locator: "edit",
					rangeStart: 0,
					rangeEnd: 0,
					kind: "§edit-result",
					content: null,
					metadata,
					diagnostics: [],
				},
			],
			diagnostics: [],
			done: true,
		},
	];
}

async function tempFile(content: string): Promise<string> {
	const name = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
	const filePath = path.join(tmpDir, name);
	await writeFile(filePath, content);
	return filePath;
}
async function edit(params: any): Promise<ReturnType<CodepathEditTool["execute"]>> {
	const tool = new CodepathEditTool(createSession());
	return tool.execute("t", params);
}
describe("CodepathEditTool", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
			// Stub fixture used by mock-only structural dispatch tests.
			// PLAN-317 BUG-403 added a pre-flight existence check; tests that
			// only verify call shape (not real edits) still need the target to
			// exist on disk.
			await writeFile(path.join(tmpDir, "src/example.ts"), "function oldName() {}\n");
		} catch {}
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true });
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("performs lineReplace with a numeric anchor", async () => {
		const file = path.join(tmpDir, "lineid.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: 2 }, content: ["delta"] },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		const content = await fs.readFile(file, "utf-8");
		expect(content).toBe("alpha\ndelta\ngamma\n");
	});

	it("appends at EOF via anchorless append", async () => {
		const file = path.join(tmpDir, "append.txt");
		await writeFile(file, "alpha");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileAppend", content: ["beta"] } }],
		});
		// PLAN-308: legacy `append` now routes via kernel TextResolver; result text
		// is a kernel-rendered diff. Asserting file-content outcome is the durable check.
		expect((result as any).isError).toBeFalsy();
		const content = await fs.readFile(file, "utf-8");
		expect(content).toContain("alpha");
		expect(content).toContain("beta");
	});

	it("creates a file with content via anchorless fileAppend on missing target", async () => {
		const file = path.join(tmpDir, "newly-created.txt");
		// Pre-condition: file must NOT exist
		expect(await fs.exists(file)).toBe(false);
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileAppend", content: ["alpha", "beta"] } }],
		});
		expect((result as any).isError).toBeFalsy();
		const content = await fs.readFile(file, "utf-8");
		expect(content).toContain("alpha");
		expect(content).toContain("beta");
	});

	it("creates a file with content via anchorless fileAppend (new kind) on missing target", async () => {
		const file = path.join(tmpDir, "newly-created-v2.txt");
		expect(await fs.exists(file)).toBe(false);
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileAppend", content: "fresh content" } }],
		});
		expect((result as any).isError).toBeFalsy();
		const content = await fs.readFile(file, "utf-8");
		expect(content).toBe("fresh content");
	});

	it("prepends at BOF via anchorless prepend", async () => {
		const file = path.join(tmpDir, "prepend.txt");
		await writeFile(file, "beta");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "filePrepend", content: ["alpha"] } }],
		});
		expect((result as any).isError).toBeFalsy();
		const content = await fs.readFile(file, "utf-8");
		expect(content).toContain("alpha");
		expect(content).toContain("beta");
	});

	it("dispatches structural rename to executeCodePath", async () => {
		await writeFile(path.join(tmpDir, "src/example.ts"), "function oldName() {}\n");
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts::oldName",
					action: { kind: "symbolRename", newName: "newName" },
				},
			],
		});
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				root: tmpDir,
				target: "src/example.ts::oldName",
				actions: [expect.objectContaining({ kind: "symbolRename", newName: "newName" })],
			}),
		);
	});

	it("surfaces structural edit errors from executeCodePath", async () => {
		await writeFile(path.join(tmpDir, "src/example.ts"), "function oldName() {}\n");
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [],
				diagnostics: [{ variant: "no_matches", message: "oldName not found", span: undefined }],
				done: true,
			},
		] as any);
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: "src/example.ts::oldName", action: { kind: "symbolRename", newName: "newName" } }],
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
						kind: "filePatch",
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

	// PLAN-317: numeric line ops route through the kernel TextResolver, which
	// reports `editCount: 0` on a no-op rather than the TS-side
	// "No changes\nidempotent=true" rejection. The idempotent flag was a
	// hashline-mode convenience; numeric line ops succeed silently on no-op.
	it("lineReplace with identical content writes no change", async () => {
		const file = path.join(tmpDir, "noop.txt");
		await writeFile(file, "same\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: 1 }, content: ["same"] },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("same\n");
	});

	it("passes occurrence first to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "fileFindReplace", find: "foo", content: "bar", occurrence: "first" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].occurrence).toBe("first");
	});

	it("passes occurrence last to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "fileFindReplace", find: "foo", content: "bar", occurrence: "last" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].occurrence).toBe("last");
	});

	it("passes occurrence all to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "fileFindReplace", find: "foo", content: "bar", occurrence: "all" },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].occurrence).toBe("all");
	});

	it("passes occurrence N to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [
				{
					target: "src/example.ts",
					action: { kind: "fileFindReplace", find: "foo", content: "bar", occurrence: 3 },
				},
			],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].occurrence).toBe(3);
	});

	// PLAN-317: LINE#HASH anchors deleted. The kernel now rejects string
	// anchors at the schema layer ("expected u32") — staleness detection is
	// gone, replaced by optimistic edits against raw line numbers.
	it("rejects legacy LINE#HASH string anchors", async () => {
		const file = path.join(tmpDir, "legacy.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: "2#ZZ" } as any, content: ["delta"] },
				},
			],
		});
		expect((result as any).isError).toBe(true);
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "edit")).toBe(true);
	});
});

describe("action passthrough", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
			await writeFile(path.join(tmpDir, "src/example.ts"), "class Foo {}\n");
		} catch {}
	});
	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true });
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	async function captureActions(action: any): Promise<any> {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
		const tool = new CodepathEditTool(createSession());
		await tool.execute("t", {
			operations: [{ target: "src/example.ts::Foo", action }],
		});
		const call = spy.mock.calls[0]?.[0] as any;
		return call?.actions?.[0];
	}

	it("symbolInsertBefore content string passes through", async () => {
		const sent = await captureActions({ kind: "symbolInsertBefore", content: "// hi" });
		expect(sent.content).toBe("// hi");
	});

	it("symbolInsertBefore content array passes through", async () => {
		const sent = await captureActions({ kind: "symbolInsertBefore", content: ["a", "b"] });
		expect(sent.content).toEqual(["a", "b"]);
	});

	it("symbolInsertAfter content passes through", async () => {
		const sent = await captureActions({ kind: "symbolInsertAfter", content: "// after" });
		expect(sent.content).toBe("// after");
	});

	it("symbolSplice mode passes through", async () => {
		const sent = await captureActions({ kind: "symbolSplice", mode: "self" });
		expect(sent.mode).toBe("self");
	});

	it("symbolWrap content array passes through", async () => {
		const sent = await captureActions({ kind: "symbolWrap", content: ["if (true) {", "$BODY", "}"] });
		expect(sent.content).toEqual(["if (true) {", "$BODY", "}"]);
	});

	it("symbolFindReplace propagates find/content (regression)", async () => {
		const sent = await captureActions({ kind: "symbolFindReplace", find: "foo", content: "bar" });
		expect(sent.find).toBe("foo");
		expect(sent.content).toBe("bar");
	});
});

describe("BUG-341 zero-byte guard and routing", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
		} catch {}
	});
	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true });
		} catch {}
	});

	it("delete on bare path unlinks file", async () => {
		const file = path.join(tmpDir, "delete-bare.txt");
		await writeFile(file, "hi\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileDelete" } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(await fs.exists(file)).toBe(false);
	});

	it("delete on path::Symbol erases bytes but file survives", async () => {
		const file = path.join(tmpDir, "delete-symbol.ts");
		await writeFile(file, "export const X = 1;\nexport const Y = 2;\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: `${file}::X`, action: { kind: "symbolDelete" } }],
		});
		expect(await fs.exists(file)).toBe(true);
		const content = await fs.readFile(file, "utf-8");
		expect(content).not.toContain("export const X");
	});

	test("insertBefore with numeric line inserts before that line", async () => {
		const file = await tempFile(`alpha\nbeta\ngamma\n`);
		const result = await edit({
			operations: [{ target: file, action: { kind: "lineInsert", at: { side: "before", line: 2 }, content: ["INSERTED"] } }],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nINSERTED\nbeta\ngamma\n");
	});

	test("insertAfter with numeric line inserts after that line", async () => {
		const file = await tempFile(`a\nb\nc\n`);
		await edit({ operations: [{ target: file, action: { kind: "lineInsert", at: { side: "after", line: 2 }, content: ["X"] } }] });
		expect(await fs.readFile(file, "utf8")).toBe("a\nb\nX\nc\n");
	});

	// PLAN-317: legacy `2#XX` anchors rejected by schema with `expected u32`.
	test("insertBefore with legacy LINE#HASH string is rejected", async () => {
		const file = await tempFile(`alpha\nbeta\ngamma\n`);
		const result = await edit({
			operations: [{ target: file, action: { kind: "lineInsert", at: { side: "before", anchor: "2#XX" } as any, content: ["X"] } }],
		});
		expect((result as any).isError).toBe(true);
	});
});

describe("BUG-342 batch fail-fast + transaction:strict", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
		} catch {}
	});
	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	test("failed batch propagates isError=true", async () => {
		const file = path.join(tmpDir, "f.ts");
		await writeFile(file, "const a = 1;\n");
		const result = await edit({
			operations: [{ target: file, action: { kind: "fileFindReplace", find: "NOTPRESENT", content: "X" } }],
		});
		expect((result as { isError?: boolean }).isError).toBe(true);
	});

	test("batch with mid-failure short-circuits subsequent ops (best-effort default)", async () => {
		const a = path.join(tmpDir, "a.ts");
		const b = path.join(tmpDir, "b.ts");
		const c = path.join(tmpDir, "c.ts");
		await writeFile(a, "const alpha = 1;\n");
		await writeFile(b, "const beta = 2;\n");
		await writeFile(c, "const gamma = 3;\n");
		const result = await edit({
			operations: [
				{ target: a, action: { kind: "fileFindReplace", find: "alpha", content: "A1" } },
				{ target: b, action: { kind: "fileFindReplace", find: "NOPE", content: "X" } },
				{ target: c, action: { kind: "fileFindReplace", find: "gamma", content: "G3" } },
			],
		});
		expect((result as { isError?: boolean }).isError).toBe(true);
		// op 1 applied (best-effort); op 3 skipped
		expect(await fs.readFile(a, "utf8")).toBe("const A1 = 1;\n");
		expect(await fs.readFile(c, "utf8")).toBe("const gamma = 3;\n");
		expect(getText(result)).toMatch(/operation 2.*failed/i);
		expect(getText(result)).toMatch(/operation 3.*skipped/i);
	});

	test("batch with transaction:strict rolls back on failure", async () => {
		const a = path.join(tmpDir, "a.ts");
		const b = path.join(tmpDir, "b.ts");
		await writeFile(a, "const alpha = 1;\n");
		await writeFile(b, "const beta = 2;\n");
		const result = await edit({
			transaction: "strict",
			operations: [
				{ target: a, action: { kind: "fileFindReplace", find: "alpha", content: "A1" } },
				{ target: b, action: { kind: "fileFindReplace", find: "NOPE", content: "X" } },
			],
		} as any);
		expect((result as { isError?: boolean }).isError).toBe(true);
		// BOTH files restored
		expect(await fs.readFile(a, "utf8")).toBe("const alpha = 1;\n");
		expect(await fs.readFile(b, "utf8")).toBe("const beta = 2;\n");
	});

	test("batch transaction:strict unlinks file that didn't exist before", async () => {
		const created = path.join(tmpDir, `new-${Date.now()}.ts`);
		const existing = path.join(tmpDir, "existing.ts");
		await writeFile(existing, "const x = 1;\n");
		const result = await edit({
			transaction: "strict",
			operations: [
				{ target: created, action: { kind: "fileCreate", content: "const fresh = 1;\n" } },
				{ target: existing, action: { kind: "fileFindReplace", find: "NOPE", content: "X" } },
			],
		} as any);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(await fs.exists(created)).toBe(false);
		expect(await fs.readFile(existing, "utf8")).toBe("const x = 1;\n");
	});

	test("successful batch returns operations: N in details with isError unset", async () => {
		const a = path.join(tmpDir, "a.ts");
		const b = path.join(tmpDir, "b.ts");
		await writeFile(a, "const a = 1;\n");
		await writeFile(b, "const b = 2;\n");
		const result = await edit({
			operations: [
				{ target: a, action: { kind: "fileFindReplace", find: "a = 1", content: "a = 11" } },
				{ target: b, action: { kind: "fileFindReplace", find: "b = 2", content: "b = 22" } },
			],
		});
		expect((result as { isError?: boolean }).isError).toBeFalsy();
		expect((result.details as { operations?: number } | undefined)?.operations).toBe(2);
	});

	test("single-op failure returns the per-op result unchanged (regression)", async () => {
		const a = path.join(tmpDir, "a.ts");
		await writeFile(a, "const a = 1;\n");
		const result = await edit({
			operations: [{ target: a, action: { kind: "fileFindReplace", find: "NOPE", content: "X" } }],
		});
		// Single-op behavior: per-op result returned directly. Aggregate envelope is for multi-op only.
		expect(result.details).toBeDefined();
	});
});

describe("cwd-prefix duplication guard", () => {
	beforeEach(async () => {
		await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true }).catch(() => {});
	});

	it("auto-coalesces relative target that duplicates cwd tail (bug pattern)", async () => {
		const nested = path.join(tmpDir, "apps", "hotelcomm");
		await fs.mkdir(nested, { recursive: true });
		const tool = new CodepathEditTool({
			cwd: nested,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});
		const result = await tool.execute("t", {
			operations: [
				{
					target: "apps/hotelcomm/lib/foo.ex",
					action: { kind: "fileAppend", content: ["x"] },
				},
			],
		});
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		// Warning text surfaced from the coalesce decision.
		expect(text).toContain("auto-stripped");
		expect(text).toContain("apps/hotelcomm");
		// File written at the coalesced (correct) location, NOT the doubled one.
		expect(await fs.exists(path.join(nested, "apps", "hotelcomm", "lib", "foo.ex"))).toBe(false);
		expect(await fs.exists(path.join(nested, "lib", "foo.ex"))).toBe(true);
	});
});
