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

	it("dispatches structural rename to executeCodePath", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
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
				target: "src/example.ts::oldName",
				actions: [expect.objectContaining({ kind: "rename", content: "newName" })],
			}),
		);
	});

	it("surfaces structural edit errors from executeCodePath", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [],
				diagnostics: [{ variant: "no_matches", message: "oldName not found", span: undefined }],
				done: true,
			},
		] as any);
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
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
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
		expect(call.actions[0].occurrence).toBe("first");
	});

	it("passes occurrence last to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
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
		expect(call.actions[0].occurrence).toBe("last");
	});

	it("passes occurrence all to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
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
		expect(call.actions[0].occurrence).toBe("all");
	});

	it("passes occurrence N to structural action", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue(mockEditResult());
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
		expect(call.actions[0].occurrence).toBe(3);
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

describe("action normalizer (FEAT-701)", () => {
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

	it("insertBefore propagates lines as string", async () => {
		const sent = await captureActions({ kind: "insertBefore", lines: "// hi" });
		expect(sent.lines).toBe("// hi");
	});

	it("insertBefore propagates lines as array", async () => {
		const sent = await captureActions({ kind: "insertBefore", lines: ["a", "b"] });
		// normalizeLines collapses arrays into newline-joined strings.
		expect(typeof sent.lines).toBe("string");
		expect(sent.lines).toContain("a");
		expect(sent.lines).toContain("b");
	});

	it("insertAfter propagates lines", async () => {
		const sent = await captureActions({ kind: "insertAfter", lines: "// after" });
		expect(sent.lines).toBe("// after");
	});

	it("splice propagates pos and end", async () => {
		const sent = await captureActions({
			kind: "splice",
			pos: "3#AB",
			end: "5#CD",
			lines: ["x"],
		});
		expect(sent.pos).toBe("3#AB");
		expect(sent.end).toBe("5#CD");
		expect(typeof sent.lines).toBe("string");
		expect(sent.lines).toContain("x");
	});

	// Patch is intercepted by `isPatchAction` and routed to the patch
	// helper (not executeCodePath), so the structural normalizer is not
	// involved. Validate via wrap (which IS structural) instead.
	it("wrap propagates content array", async () => {
		const sent = await captureActions({
			kind: "wrap",
			content: ["if (true) {", "$BODY", "}"],
		});
		expect(typeof sent.content).toBe("string");
		expect(sent.content).toContain("$BODY");
	});

	// Append/Prepend/Replace go through the LINE#ID edit path, NOT the
	// structural normalizer. We exercise insertBefore as a structural
	// regression for the lines field instead.
	it("insertBefore omits lines when not set", async () => {
		const sent = await captureActions({ kind: "insertBefore" } as any);
		expect(sent.lines).toBeUndefined();
	});

	it("findAndReplace propagates find (regression)", async () => {
		const sent = await captureActions({ kind: "findAndReplace", find: "foo", content: "bar" });
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
			operations: [{ target: file, action: { kind: "delete" } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(await fs.exists(file)).toBe(false);
	});

	it("delete on path::Symbol erases bytes but file survives", async () => {
		const file = path.join(tmpDir, "delete-symbol.ts");
		await writeFile(file, "export const X = 1;\nexport const Y = 2;\n");
		const tool = new CodepathEditTool(createSession());
		const result = await tool.execute("t", {
			operations: [{ target: `${file}::X`, action: { kind: "delete" } }],
		});
		expect(await fs.exists(file)).toBe(true);
		const content = await fs.readFile(file, "utf-8");
		expect(content).not.toContain("export const X");
	});

	test("insertBefore with LINE#ID anchor inserts before that line", async () => {
		const file = await tempFile(`alpha\nbeta\ngamma\n`);
		const tag = computeLineHash(2, "beta");
		const result = await edit({
			operations: [{ target: file, action: { kind: "insertBefore", pos: `2#${tag}`, lines: ["INSERTED"] } }],
		});
		expect(getText(result)).not.toContain("changed");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nINSERTED\nbeta\ngamma\n");
	});

	test("insertAfter with LINE#ID inserts after that line", async () => {
		const file = await tempFile(`a\nb\nc\n`);
		const tag = computeLineHash(2, "b");
		await edit({ operations: [{ target: file, action: { kind: "insertAfter", pos: `2#${tag}`, lines: ["X"] } }] });
		expect(await fs.readFile(file, "utf8")).toBe("a\nb\nX\nc\n");
	});

	test("insertBefore with stale LINE#ID returns hash-mismatch diagnostic", async () => {
		const file = await tempFile(`alpha\nbeta\ngamma\n`);
		const result = await edit({
			operations: [{ target: file, action: { kind: "insertBefore", pos: "2#XX", lines: ["X"] } }],
		});
		expect(getText(result)).toContain("changed since last read");
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
			operations: [{ target: file, action: { kind: "findAndReplace", find: "NOTPRESENT", content: "X" } }],
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
				{ target: a, action: { kind: "findAndReplace", find: "alpha", content: "A1" } },
				{ target: b, action: { kind: "findAndReplace", find: "NOPE", content: "X" } },
				{ target: c, action: { kind: "findAndReplace", find: "gamma", content: "G3" } },
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
				{ target: a, action: { kind: "findAndReplace", find: "alpha", content: "A1" } },
				{ target: b, action: { kind: "findAndReplace", find: "NOPE", content: "X" } },
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
				{ target: created, action: { kind: "create", content: "const fresh = 1;\n" } },
				{ target: existing, action: { kind: "findAndReplace", find: "NOPE", content: "X" } },
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
				{ target: a, action: { kind: "findAndReplace", find: "a = 1", content: "a = 11" } },
				{ target: b, action: { kind: "findAndReplace", find: "b = 2", content: "b = 22" } },
			],
		});
		expect((result as { isError?: boolean }).isError).toBeFalsy();
		expect((result.details as { operations?: number } | undefined)?.operations).toBe(2);
	});

	test("single-op failure returns the per-op result unchanged (regression)", async () => {
		const a = path.join(tmpDir, "a.ts");
		await writeFile(a, "const a = 1;\n");
		const result = await edit({
			operations: [{ target: a, action: { kind: "findAndReplace", find: "NOPE", content: "X" } }],
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
					action: { kind: "append", lines: ["x"] },
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
