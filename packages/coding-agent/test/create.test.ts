import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CreateTool, createTools, type ToolSession } from "@spell/pi-coding-agent/tools";
import * as nativesModule from "@spell/pi-natives";

const tmpDir = path.join(process.cwd(), "packages/coding-agent/test/tmp-create");

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

function getText(result: Awaited<ReturnType<CreateTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("CreateTool", () => {
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

	it("creates a text file and persists it to disk", async () => {
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "hello.txt", content: "hello world" });
		expect(getText(result)).toContain("Created");
		// The whole point: the file actually exists on disk with the content.
		const content = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
		expect(content).toBe("hello world");
	});

	it("creates parent directories on demand", async () => {
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "deep/nested/dir/hello.txt", content: "hi" });
		expect(getText(result)).toContain("Created");
		const content = await fs.readFile(path.join(tmpDir, "deep/nested/dir/hello.txt"), "utf-8");
		expect(content).toBe("hi");
	});

	it("creates from base64 content", async () => {
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", {
			path: "b64.txt",
			content: { kind: "base64", data: Buffer.from("hello").toString("base64") },
		});
		expect(getText(result)).toContain("Created");
		const content = await fs.readFile(path.join(tmpDir, "b64.txt"), "utf-8");
		expect(content).toBe("hello");
	});

	it("serialises JSON-object content the arg-coercion layer parsed string→object", async () => {
		// Regression: the model emits a `package.json` body as a JSON object; the
		// validation/coercion layer turns the string into an actual object before
		// it reaches the tool. Previously create fell into the artifact-URI branch
		// and threw `undefined is not an object (evaluating 'input.match')`.
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", {
			path: "pkg.json",
			content: { name: "demo", version: "1.0.0", scripts: { build: "tsc" } } as never,
		});
		expect(result.isError).toBeFalsy();
		expect(getText(result)).toContain("Created");
		const content = await fs.readFile(path.join(tmpDir, "pkg.json"), "utf-8");
		expect(JSON.parse(content)).toEqual({ name: "demo", version: "1.0.0", scripts: { build: "tsc" } });
	});

	it("serialises JSON-array content coerced away from string", async () => {
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "arr.json", content: [1, 2, 3] as never });
		expect(result.isError).toBeFalsy();
		const content = await fs.readFile(path.join(tmpDir, "arr.json"), "utf-8");
		expect(JSON.parse(content)).toEqual([1, 2, 3]);
	});

	it("reports a clear diagnostic for a bytes payload missing its artifactUri", async () => {
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "x.bin", content: { kind: "bytes" } as never });
		expect(result.isError).toBeTruthy();
		expect(getText(result)).toContain("artifact URI");
	});

	it("rejects creation when file exists without force", async () => {
		const existingFile = path.join(tmpDir, "exists.txt");
		await fs.writeFile(existingFile, "old", "utf-8");
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "exists.txt", content: "new" });
		expect(getText(result)).toContain("already exists");
		expect(getText(result)).toContain("force=true");
		// File must remain untouched.
		expect(await fs.readFile(existingFile, "utf-8")).toBe("old");
	});

	it("overwrites existing file when force=true", async () => {
		const existingFile = path.join(tmpDir, "force.txt");
		await fs.writeFile(existingFile, "old", "utf-8");
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "force.txt", content: "new content", force: true });
		expect(getText(result)).toContain("Created");
		expect(await fs.readFile(existingFile, "utf-8")).toBe("new content");
	});

	it("resolves artifact URI for bytes content", async () => {
		const tool = new CreateTool(
			createSession({
				internalRouter: {
					canHandle: (url: string) => url.startsWith("artifact://"),
					resolve: async () => ({ content: "artifact bytes", sourcePath: "artifact://x" }),
				} as any,
			}),
		);
		const result = await tool.execute("t", {
			path: "art.txt",
			content: { kind: "bytes", artifactUri: "artifact://x" },
		});
		expect(getText(result)).toContain("Created");
		expect(await fs.readFile(path.join(tmpDir, "art.txt"), "utf-8")).toBe("artifact bytes");
	});

	it("returns error for unresolvable artifact URI", async () => {
		const tool = new CreateTool(
			createSession({
				internalRouter: {
					canHandle: () => false,
					resolve: async () => {
						throw new Error("no");
					},
				} as any,
			}),
		);
		const result = await tool.execute("t", {
			path: "fail.txt",
			content: { kind: "bytes", artifactUri: "artifact://missing" },
		});
		expect(getText(result)).toContain("Cannot resolve artifact URI");
		// File must NOT have been created.
		expect(await fs.exists(path.join(tmpDir, "fail.txt"))).toBe(false);
	});

	it("dispatches create to executeCodePath with correct shape", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [
					{
						locator: "edit",
						rangeStart: 0,
						rangeEnd: 0,
						kind: "§edit-result",
						content: null as any,
						metadata: { editCount: 1, created: true },
						diagnostics: [],
					},
				],
				diagnostics: [],
				done: true,
			},
		] as any);
		const statSpy = spyOn(fs, "stat").mockResolvedValue({ size: 11 } as any);
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "spy.txt", content: "spy content" });
		expect(getText(result)).toContain("Created");
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				target: "spy.txt",
				actions: [expect.objectContaining({ kind: "fileCreate", content: "spy content", force: false })],
			}),
		);
		spy.mockRestore();
		statSpy.mockRestore();
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "create")).toBe(true);
	});

	describe("cwd-prefix duplication guard", () => {
		it("auto-coalesces path that duplicates cwd tail (bug pattern, no nested evidence)", async () => {
			// Mirror the bug from the linked transcript: cwd = .../monorepo/apps/hotelcomm,
			// agent passes "apps/hotelcomm/lib/foo.ex". The nested parent dir does not
			// exist on disk → helper coalesces and writes at the stripped location,
			// surfacing a warning so the agent self-corrects next turn.
			const nested = path.join(tmpDir, "apps", "hotelcomm");
			await fs.mkdir(nested, { recursive: true });
			const tool = new CreateTool(createSession({ cwd: nested }));
			const result = await tool.execute("t", {
				path: "apps/hotelcomm/lib/foo.ex",
				content: "defmodule Foo do\nend\n",
			});
			const text = getText(result);
			expect(text).toContain("Created");
			expect(text).toContain("auto-stripped");
			expect(text).toContain("apps/hotelcomm");
			expect(text).toContain("lib/foo.ex");
			// File written at the coalesced (correct) location, NOT the doubled one.
			const doubled = path.join(nested, "apps", "hotelcomm", "lib", "foo.ex");
			const coalesced = path.join(nested, "lib", "foo.ex");
			expect(await fs.exists(doubled)).toBe(false);
			expect(await fs.exists(coalesced)).toBe(true);
		});

		it("keeps literal nested path when nested parent dir exists (legit nesting)", async () => {
			// User actually wants a nested layout: cwd `/tmp/x/apps/foo`, target
			// `apps/foo/sub.ts`, and `apps/foo/` already exists under cwd.
			const nested = path.join(tmpDir, "apps", "foo");
			await fs.mkdir(path.join(nested, "apps", "foo"), { recursive: true });
			const tool = new CreateTool(createSession({ cwd: nested }));
			const result = await tool.execute("t", {
				path: "apps/foo/sub.ts",
				content: "export const x = 1;\n",
			});
			const text = getText(result);
			expect(text).toContain("Created");
			expect(text).toContain("Kept literal interpretation");
			// File written at the nested (literal) location.
			expect(await fs.exists(path.join(nested, "apps", "foo", "sub.ts"))).toBe(true);
		});

		it("does NOT false-positive on partial-segment substring overlap", async () => {
			// cwd ends with `src`, path starts with `srcs/...` — segments differ,
			// must succeed.
			const src = path.join(tmpDir, "src");
			await fs.mkdir(src, { recursive: true });
			const tool = new CreateTool(createSession({ cwd: src }));
			const result = await tool.execute("t", {
				path: "srcs/foo.ts",
				content: "export const x = 1;\n",
			});
			expect(getText(result)).toContain("Created");
			expect(await fs.exists(path.join(src, "srcs", "foo.ts"))).toBe(true);
		});

		it("exempts absolute paths from the guard", async () => {
			const nested = path.join(tmpDir, "apps", "hotelcomm");
			await fs.mkdir(nested, { recursive: true });
			const absTarget = path.join(nested, "apps", "hotelcomm", "lib", "abs.ex");
			const tool = new CreateTool(createSession({ cwd: nested }));
			const result = await tool.execute("t", {
				path: absTarget,
				content: "defmodule Abs do\nend\n",
			});
			expect(getText(result)).toContain("Created");
			expect(await fs.exists(absTarget)).toBe(true);
		});

		it("echoes the absolute resolved path on success", async () => {
			const tool = new CreateTool(createSession());
			const result = await tool.execute("t", { path: "echo.txt", content: "hi" });
			const text = getText(result);
			expect(text).toContain("Created echo.txt");
			// Second line includes the absolute resolved path — lets the agent
			// self-check the resolution against its mental model.
			expect(text).toContain(`→ ${path.join(tmpDir, "echo.txt")}`);
		});
	});
});
