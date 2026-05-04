import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { setupFixtureDir, teardownFixtureDir, writeFiles } from "../parity-helpers";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function getText(result: Awaited<ReturnType<CodepathEditTool["execute"]>>): string {
	return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

describe("edit (LINE#ID + patch) parity", () => {
	let testDir: string;
	let editTool: CodepathEditTool;

	beforeEach(() => {
		testDir = setupFixtureDir();
		editTool = new CodepathEditTool(createSession(testDir));
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it("LINE#ID replace single line", async () => {
		writeFiles(testDir, { "file.txt": "alpha\nbeta\ngamma\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "replace", pos: "2#beta", lines: ["delta"] } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(file, "utf-8")).toBe("alpha\ndelta\ngamma\n");
	});

	it("LINE#ID replace range with pos+end", async () => {
		writeFiles(testDir, { "file.txt": "a\nb\nc\nd\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "replace", pos: "2#b", end: "3#c", lines: ["x"] } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(file, "utf-8")).toBe("a\nx\nd\n");
	});

	it("LINE#ID append at EOF anchorless", async () => {
		writeFiles(testDir, { "file.txt": "alpha\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "append", lines: ["beta"] } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(file, "utf-8")).toBe("alpha\n\nbeta\n");
	});

	it("LINE#ID prepend at BOF anchorless", async () => {
		writeFiles(testDir, { "file.txt": "beta\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "prepend", lines: ["alpha"] } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(file, "utf-8")).toBe("alpha\nbeta\n");
	});

	it("LINE#ID replace with stale anchor emits diagnostic", async () => {
		writeFiles(testDir, { "file.txt": "alpha\nbeta\ngamma\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "replace", pos: "2#WRONG", lines: ["delta"] } }],
		});
		expect(getText(result)).toContain("stale_anchor");
	});

	it("patch mode unified diff", async () => {
		writeFiles(testDir, { "file.txt": "line one\nline two\nline three\n" });
		const file = path.join(testDir, "file.txt");
		const diff = `--- file.txt\n+++ file.txt\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO\n line three\n`;
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "patch", diff } }],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(file, "utf-8")).toBe("line one\nline TWO\nline three\n");
	});

	it("patch mode creates missing file", async () => {
		const file = path.join(testDir, "new.txt");
		const diff = `--- new.txt\n+++ new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n`;
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "patch", diff } }],
		});
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(file, "utf-8")).toBe("hello\nworld\n");
	});

	it("idempotent no-op returns idempotent message", async () => {
		writeFiles(testDir, { "file.txt": "alpha\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "replace", pos: "1#alpha", lines: ["alpha"] } }],
			idempotent: true,
		});
		expect(getText(result)).toContain("idempotent");
	});

	it("non-idempotent no-op warns", async () => {
		writeFiles(testDir, { "file.txt": "alpha\n" });
		const file = path.join(testDir, "file.txt");
		const result = await editTool.execute("t", {
			operations: [{ target: file, action: { kind: "replace", pos: "1#alpha", lines: ["alpha"] } }],
		});
		expect(getText(result)).toContain("No changes");
	});

	it("multiple operations in single call", async () => {
		writeFiles(testDir, { "a.txt": "a\n", "b.txt": "b\n" });
		const a = path.join(testDir, "a.txt");
		const b = path.join(testDir, "b.txt");
		const result = await editTool.execute("t", {
			operations: [
				{ target: a, action: { kind: "replace", pos: "1#a", lines: ["A"] } },
				{ target: b, action: { kind: "replace", pos: "1#b", lines: ["B"] } },
			],
		});
		expect(getText(result)).toContain("Updated");
		expect(fs.readFileSync(a, "utf-8")).toBe("A\n");
		expect(fs.readFileSync(b, "utf-8")).toBe("B\n");
	});

	it.todo("structural findAndReplace via NAPI edit command");
	it.todo("structural rawTextReplace via NAPI edit command");
	it.todo("structural wrap via NAPI edit command");
	it.todo("structural rename via NAPI edit command");
	it.todo("structural delete via NAPI edit command");
	it.todo("structural insertBefore via NAPI edit command");
	it.todo("structural insertAfter via NAPI edit command");
	it.todo("structural splice via NAPI edit command");
	it.todo("structural move via NAPI edit command");
	it.todo("structural clone via NAPI edit command");
	it.todo("structural transpose via NAPI edit command");
	it.todo("structural renameClassToken via NAPI edit command");
	it.todo("structural renameIdToken via NAPI edit command");
	it.todo("structural renameCustomProperty via NAPI edit command");
	it.todo("structural removeDeadStyle via NAPI edit command");
	it.todo("structural promote via NAPI edit command");
	it.todo("structural demote via NAPI edit command");
	it.todo("structural replaceCodeBlock via NAPI edit command");
	it.todo("preview-then-resolve workflow");
	it.todo("diagnostic for file-not-found");
	it.todo("diagnostic for sandbox violation");
	it.todo("diagnostic for mode-guard rejection");
	it.todo("write-shrink guard");
	it.todo("parse-regression guard");
	it.todo("force flag bypasses guards");
	it.todo("nested children operations");
	it.todo("occurrence selectors");
	it.todo("scope=body vs scope=target");
	it.todo("preserve CRLF line endings");
	it.todo("preserve BOM");
	it.todo("create-via-edit action");
});
