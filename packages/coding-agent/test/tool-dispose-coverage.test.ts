import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TOOLS_DIR = path.join(import.meta.dir, "../src/tools");
const SPELL_TOOLS_DIR = path.join(TOOLS_DIR, "spell");

// Field types that indicate the tool owns a disposable resource.
const DISPOSABLE_FIELD_TYPES = new Set([
	"Browser",
	"Page",
	"QmlBridge",
	"QmlBridgeProcess",
	"ProcessTerminal",
	"OrgToolDefinition",
]);

async function getToolFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const dir of [TOOLS_DIR, SPELL_TOOLS_DIR]) {
		try {
			const entries = await fs.readdir(dir);
			for (const entry of entries) {
				if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
					files.push(path.join(dir, entry));
				}
			}
		} catch {
			// Directory may not exist
		}
	}
	return files;
}

interface ToolClassInfo {
	file: string;
	className: string;
	disposableFields: string[];
	hasDispose: boolean;
}

function analyzeToolClass(content: string, filePath: string): ToolClassInfo[] {
	const results: ToolClassInfo[] = [];
	// Match class declarations that implement AgentTool
	const classRegex = /class\s+(\w+)(?:\s+extends\s+\w+)?\s+implements\s+AgentTool[^{]*\{/g;
	for (const classMatch of content.matchAll(classRegex)) {
		const className = classMatch[1];
		const classStart = classMatch.index;
		// Find matching closing brace (simple depth counter)
		let depth = 0;
		let classEnd = classStart;
		for (let i = classStart; i < content.length; i++) {
			if (content[i] === "{") depth++;
			else if (content[i] === "}") {
				depth--;
				if (depth === 0) {
					classEnd = i;
					break;
				}
			}
		}
		const classBody = content.slice(classStart, classEnd + 1);

		// Find ES private fields with types
		const fieldRegex = /#(\w+)(?:\?)?:\s*([\w<>|\s]+)/g;
		const disposableFields: string[] = [];
		for (const fieldMatch of classBody.matchAll(fieldRegex)) {
			const fieldType = fieldMatch[2]
				.trim()
				.replace(/\s*\|\s*null\s*$/, "")
				.replace(/\s*\|\s*undefined\s*$/, "")
				.trim();
			if (DISPOSABLE_FIELD_TYPES.has(fieldType)) {
				disposableFields.push(`#${fieldMatch[1]}: ${fieldType}`);
			}
		}

		if (disposableFields.length > 0) {
			const hasDispose = /(?:async\s+)?dispose\s*\(/.test(classBody);
			results.push({
				file: path.relative(path.join(import.meta.dir, ".."), filePath),
				className,
				disposableFields,
				hasDispose,
			});
		}
	}
	return results;
}

describe("Tool dispose coverage", () => {
	it("every AgentTool class with disposable-type private fields has dispose()", async () => {
		const toolFiles = await getToolFiles();
		const allClasses: ToolClassInfo[] = [];

		for (const filePath of toolFiles) {
			const content = await Bun.file(filePath).text();
			allClasses.push(...analyzeToolClass(content, filePath));
		}

		const missing = allClasses.filter(c => !c.hasDispose);
		expect(missing).toEqual([]);

		// Sanity: we should find at least BrowserTool, CanvasTool, OrgTool
		const classNames = allClasses.map(c => c.className);
		expect(classNames).toContain("BrowserTool");
		expect(classNames).toContain("CanvasTool");
		expect(classNames).toContain("OrgTool");
	});

	it("ExtensionToolWrapper forwards dispose to inner tool", async () => {
		// Read the wrapper source and verify dispose exists and delegates
		const wrapperPath = path.join(import.meta.dir, "../src/extensibility/extensions/wrapper.ts");
		const content = await Bun.file(wrapperPath).text();

		// ExtensionToolWrapper must have a dispose method
		expect(content).toMatch(/class ExtensionToolWrapper[\s\S]*?dispose\s*\(/);
		// It must delegate to this.tool.dispose
		expect(content).toMatch(/this\.tool\.dispose/);
	});
});
