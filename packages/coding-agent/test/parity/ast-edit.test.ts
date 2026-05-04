import { afterEach, beforeEach, describe, it } from "bun:test";
import { setupFixtureDir, teardownFixtureDir, writeFiles } from "../parity-helpers";

describe("ast-edit → edit parity", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = setupFixtureDir();
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it.todo("findAndReplace in single file");
	it.todo("findAndReplace across multiple files");
	it.todo("rawTextReplace preserves whitespace");
	it.todo("wrap adds try/catch block");
	it.todo("rename symbol");
	it.todo("delete node");
	it.todo("insertBefore adds import");
	it.todo("insertAfter adds statement");
	it.todo("splice replaces range");
	it.todo("move node up");
	it.todo("clone node");
	it.todo("transpose arguments");
	it.todo("renameClassToken");
	it.todo("renameIdToken");
	it.todo("renameCustomProperty");
	it.todo("removeDeadStyle");
	it.todo("promote node");
	it.todo("demote node");
	it.todo("replaceCodeBlock");
	it.todo("occurrence=first selector");
	it.todo("occurrence=last selector");
	it.todo("occurrence=all selector");
	it.todo("occurrence=N selector");
	it.todo("idempotent flag");
	it.todo("nested children operations");
	it.todo("preview-then-resolve workflow");
	it.todo("diagnostic for stale target");
	it.todo("diagnostic for parse error");
	it.todo("diagnostic for unsupported language");
	it.todo("multi-file batch edit");
	it.todo("scope=body restriction");
	it.todo("scope=target restriction");
});
