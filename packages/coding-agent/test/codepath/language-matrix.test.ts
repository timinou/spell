import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodepathEditTool } from "@oh-my-pi/pi-coding-agent/tools/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Language matrix — structural edits across supported languages.
 *
 * For each (language, op) cell, load a before fixture, invoke the edit tool,
 * and assert the file matches the after fixture.
 */

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lang-matrix-"));
});

afterEach(async () => {
	if (tmpDir) {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {}
	}
});

function makeSession(): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

async function runCase(
	lang: string,
	op: string,
	ext: string,
	target: string,
	action: any,
) {
	const before = await fs.readFile(
		`packages/coding-agent/test/codepath/fixtures/languages/${lang}/${op}.before.${ext}`,
		"utf-8",
	);
	const after = await fs.readFile(
		`packages/coding-agent/test/codepath/fixtures/languages/${lang}/${op}.after.${ext}`,
		"utf-8",
	);
	const filePath = path.join(tmpDir, `f.${ext}`);
	await fs.writeFile(filePath, before);

	const session = makeSession();
	const tool = new CodepathEditTool(session);
	const result = await tool.execute("test", {
		operations: [{ target: target.replace(/\$FILE/g, filePath), action }],
	});

	expect((result as any).isError).toBeFalsy();
	const actual = await fs.readFile(filePath, "utf-8");
	expect(actual.trim()).toBe(after.trim());
}

describe("typescript", () => {
	test("symbolReplace works on typescript", async () => {
		await runCase("typescript", "symbolReplace", "ts", "$FILE::greet", {
			kind: "symbolFindReplace",
			find: "return 'hello ' + name;",
			content: "return 'hello ' + name + '!';",
		});
	});

	test("symbolRename works on typescript", async () => {
		await runCase("typescript", "symbolRename", "ts", "$FILE::greet", {
			kind: "symbolRename",
			newName: "salute",
		});
	});

	test("symbolInsertAfter works on typescript", async () => {
		await runCase("typescript", "symbolInsertAfter", "ts", "$FILE::greet", {
			kind: "symbolInsertAfter",
			content: "// inserted after greet\n",
		});
	});
});

describe("rust", () => {
	test("symbolReplace works on rust", async () => {
		await runCase("rust", "symbolReplace", "rs", "$FILE::greet", {
			kind: "symbolReplace",
			scope: "whole",
			content: 'pub fn greet(name: &str) -> String {\n    format!("hello {}!", name)\n}',
		});
	});

	test("symbolRename works on rust", async () => {
		await runCase("rust", "symbolRename", "rs", "$FILE::greet", {
			kind: "symbolRename",
			newName: "salute",
		});
	});

	test("symbolInsertAfter works on rust", async () => {
		await runCase("rust", "symbolInsertAfter", "rs", "$FILE::greet", {
			kind: "symbolInsertAfter",
			content: "// inserted after greet\n",
		});
	});
});

describe("python", () => {
	test("symbolReplace works on python", async () => {
		await runCase("python", "symbolReplace", "py", "$FILE::greet", {
			kind: "symbolReplace",
			scope: "whole",
			content: "def greet(name):\n    return f'hello {name}!'",
		});
	});

	test("symbolRename works on python", async () => {
		await runCase("python", "symbolRename", "py", "$FILE::greet", {
			kind: "symbolRename",
			newName: "salute",
		});
	});

	test("symbolInsertAfter works on python", async () => {
		await runCase("python", "symbolInsertAfter", "py", "$FILE::greet", {
			kind: "symbolInsertAfter",
			content: "# inserted after greet\n",
		});
	});
});

describe("markdown", () => {
	test("headingPromote works on markdown", async () => {
		await runCase("markdown", "headingPromote", "md", "$FILE::Top", {
			kind: "headingPromote",
		});
	});

	test("headingDemote works on markdown", async () => {
		await runCase("markdown", "headingDemote", "md", "$FILE::Top", {
			kind: "headingDemote",
		});
	});

	test("headingReplaceBlock works on markdown", async () => {
		await runCase("markdown", "headingReplaceBlock", "md", "$FILE::Top", {
			kind: "symbolReplace",
			scope: "whole",
			content: "# Top\n\nReplaced content.",
		});
	});
});

describe("css", () => {
	test("cssRenameClassToken works on css", async () => {
		await runCase("css", "cssRenameClassToken", "css", "$FILE::.my-class", {
			kind: "cssRenameClassToken",
			find: "my-class",
			replace: "renamed-class",
		});
	});

	test("cssRenameIdToken works on css", async () => {
		await runCase("css", "cssRenameIdToken", "css", "$FILE::#my-id", {
			kind: "cssRenameIdToken",
			find: "my-id",
			replace: "renamed-id",
		});
	});

	test.skip("cssRenameCustomProp works on css — kernel: New custom property must be a plain literal token", async () => {
		await runCase("css", "cssRenameCustomProp", "css", "$FILE:::root", {
			kind: "cssRenameCustomProp",
			find: "--my-prop",
			replace: "--renamed-prop",
		});
	});
});

describe("html", () => {
	test("symbolReplace works on html", async () => {
		await runCase("html", "symbolReplace", "html", "$FILE::section", {
			kind: "symbolReplace",
			scope: "whole",
			content: "<section>\n  <p>Goodbye world</p>\n</section>",
		});
	});

	test("symbolWrap works on html", async () => {
		await runCase("html", "symbolWrap", "html", "$FILE::section", {
			kind: "symbolWrap",
			content: ["<wrapper>", "  $BODY", "</wrapper>"],
		});
	});

	test("symbolInsertAfter works on html", async () => {
		await runCase("html", "symbolInsertAfter", "html", "$FILE::section", {
			kind: "symbolInsertAfter",
			content: "<!-- inserted after section -->\n",
		});
	});
});
