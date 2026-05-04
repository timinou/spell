import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CreateTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { setupFixtureDir, teardownFixtureDir } from "../parity-helpers";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function getText(result: Awaited<ReturnType<CreateTool["execute"]>>): string {
	return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

describe("write → create parity", () => {
	let testDir: string;
	let createTool: CreateTool;

	beforeEach(() => {
		testDir = setupFixtureDir();
		createTool = new CreateTool(createSession(testDir));
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it("creates a text file", async () => {
		const result = await createTool.execute("t", { path: "hello.txt", content: "hello world" });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "hello.txt"), "utf-8")).toBe("hello world");
	});

	it("creates a nested file path", async () => {
		const result = await createTool.execute("t", { path: "src/nested/deep.ts", content: "export const x = 1;" });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "src/nested/deep.ts"), "utf-8")).toBe("export const x = 1;");
	});

	it("rejects when file exists without force", async () => {
		fs.writeFileSync(path.join(testDir, "exists.txt"), "old");
		const result = await createTool.execute("t", { path: "exists.txt", content: "new" });
		expect(getText(result)).toContain("already exists");
		expect(fs.readFileSync(path.join(testDir, "exists.txt"), "utf-8")).toBe("old");
	});

	it("overwrites when force=true", async () => {
		fs.writeFileSync(path.join(testDir, "force.txt"), "old");
		const result = await createTool.execute("t", { path: "force.txt", content: "new", force: true });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "force.txt"), "utf-8")).toBe("new");
	});

	it("creates from base64 content", async () => {
		const b64 = Buffer.from("hello world").toString("base64");
		const result = await createTool.execute("t", { path: "b64.txt", content: { kind: "base64", data: b64 } });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "b64.txt"), "utf-8")).toBe("hello world");
	});

	it("creates empty file", async () => {
		const result = await createTool.execute("t", { path: "empty.txt", content: "" });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "empty.txt"), "utf-8")).toBe("");
	});

	it("creates file with multiline content", async () => {
		const content = "line1\nline2\nline3\n";
		const result = await createTool.execute("t", { path: "multi.txt", content });
		expect(getText(result)).toContain("Created");
		expect(fs.readFileSync(path.join(testDir, "multi.txt"), "utf-8")).toBe(content);
	});

	it.todo("creates from bytes artifact URI");
	it.todo("rejects invalid artifact URI");
	it.todo("sandbox guard rejects outside cwd");
	it.todo("mode guard rejects plan-mode paths");
	it.todo("write-shrink guard rejects oversized file");
	it.todo("parse-regression guard rejects bad syntax");
	it.todo("force bypasses write-shrink guard");
	it.todo("force bypasses parse-regression guard");
	it.todo("creates binary file from base64");
	it.todo("creates image file");
	it.todo("creates json file");
	it.todo("creates markdown file");
	it.todo("absolute path resolution");
	it.todo("relative path resolution");
});
