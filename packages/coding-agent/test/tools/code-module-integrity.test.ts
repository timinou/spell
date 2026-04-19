import { afterEach, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

afterEach(() => {
	try {
		(spyOn(nativesModule, "executeCodeBuffer") as unknown as { mockRestore?: () => void }).mockRestore?.();
	} catch {}
});

it("CodeTool module imports without ReferenceError", () => {
	expect(CodeTool).toBeDefined();
	expect(typeof CodeTool).toBe("function");
	expect(typeof CodeTool.prototype.execute).toBe("function");
});

it("CodeTool.execute with 'languages' completes without throwing a ReferenceError", async () => {
	spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
		output: [{ id: "typescript", name: "TypeScript", extensions: ["ts", "tsx"] }],
		error: false,
	});
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", { command: "languages" });
	expect(result).toBeDefined();
	expect(Array.isArray(result.content)).toBe(true);
	expect(result.details).toBeDefined();
});

it("code.ts transpiles cleanly under Bun.Transpiler", async () => {
	const codeTsPath = path.resolve(process.cwd(), "packages/coding-agent/src/tools/code.ts");
	const source = await Bun.file(codeTsPath).text();
	const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
	const output = transpiler.transformSync(source);
	expect(typeof output).toBe("string");
	expect(output.length).toBeGreaterThan(0);
	const scan = transpiler.scan(source);
	expect(Array.isArray(scan.imports)).toBe(true);
	expect(Array.isArray(scan.exports)).toBe(true);
});
