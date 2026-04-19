import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

function createSession(cwd: string) {
	return {
		cwd,
		hasUI: false,
		enableLsp: true,
		settings: Settings.isolated(),
		getSessionId: () => "test-session",
		sandboxPolicy: undefined,
	};
}

describe("WriteTool managed-buffer guards", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "write-guard-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects shrink clobber on code-supported files", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn keep() -> u32 { 1 }\n".repeat(80);
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);
		const result = await tool.execute("call-1", { path: file, content: "PLACEHOLDER" } as never);
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("WRITE_SHRINK_BLOCKED");
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("allows same-size replacement", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn keep() -> u32 { 1 }\n".repeat(80);
		const replacement = "pub fn keep() -> u32 { 2 }\n".repeat(80);
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: replacement } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(readFileSync(file, "utf8")).toBe(replacement);
	});

	it("allows small file replacement", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn keep() -> u32 { 1 }\n".repeat(5);
		const replacement = "pub fn x() {}\n";
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: replacement } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(readFileSync(file, "utf8")).toBe(replacement);
	});

	it("allows new code-supported files", async () => {
		const file = join(dir, "new.rs");
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: "pub fn x() {}\n" } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(readFileSync(file, "utf8")).toContain("pub fn x()");
	});

	it("rejects parse regressions", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn keep() -> u32 { 1 }\n";
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);
		const result = await tool.execute("call-1", { path: file, content: "pub fn broken() {\n" } as never);
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("WRITE_PARSE_REGRESSION");
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("skips parse guard when original is broken", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn broken() {\n";
		const next = "pub fn still_broken() {\n";
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: next } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(readFileSync(file, "utf8")).toBe(next);
	});

	it("bypasses both guards with force", async () => {
		const file = join(dir, "lib.rs");
		const original = "pub fn keep() -> u32 { 1 }\n".repeat(80);
		writeFileSync(file, original);
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: "PLACEHOLDER", force: true } as never);
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("Bypassed WRITE_SHRINK_BLOCKED and WRITE_PARSE_REGRESSION.");
		expect(readFileSync(file, "utf8")).toBe("PLACEHOLDER");
	});

	it("does not fire on non-code-supported paths", async () => {
		const file = join(dir, "README.txt");
		const tool = new WriteTool(createSession(dir) as never);

		const result = await tool.execute("call-1", { path: file, content: "PLACEHOLDER" } as never);
		expect(result.content[0]?.type).toBe("text");
		expect(readFileSync(file, "utf8")).toBe("PLACEHOLDER");
	});
});
