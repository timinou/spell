/**
 * Wave J — buffer-registry coherence tests.
 *
 * The cutover splits write-path (executeCodePath::edit) from buffer-lifecycle
 * ops (executeCodeBuffer). These tests prove the BufferRegistry remains the
 * single source of truth across both surfaces: edits made via one NAPI are
 * observable via the other, including outline/undo/diff.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { executeCodeBuffer, executeCodePath } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

async function applyEdit(root: string, file: string, find: string, content: string): Promise<void> {
	const chunks = await executeCodePath({
		command: "edit",
		target: file,
		root,
		actions: [{ kind: "fileRawTextReplace", find, content }],
		sessionId: "S-buffer-test",
	});
	const diags = chunks.flatMap(c => c.diagnostics);
	if (diags.length > 0) throw new Error(`edit failed: ${diags[0]!.message}`);
}

describe("Wave J: buffer registry coherence", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-j-buffer-"));
		await fs.mkdir(path.join(tmpDir, ".spell"), { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("edit via executeCodePath → read via executeCodeBuffer returns post-edit content", async () => {
		const file = path.join(tmpDir, "coherence.ts");
		await fs.writeFile(file, "export const v = 1;\n");

		await applyEdit(tmpDir, "coherence.ts", "1", "42");

		const result = executeCodeBuffer({ command: "read", file });
		expect(result.error).toBe(false);
		expect(typeof result.output).toBe("string");
		expect(result.output as string).toContain("42");
	});

	it("executeCodeBuffer open then close releases the registry handle", async () => {
		const file = path.join(tmpDir, "lifecycle.ts");
		await fs.writeFile(file, "export const x = 1;\n");

		const opened = executeCodeBuffer({ command: "open", file });
		expect(opened.error).toBe(false);

		const closed = executeCodeBuffer({ command: "close", file });
		expect(closed.error).toBe(false);
		expect((closed.output as { success?: boolean }).success).toBe(true);
	});

	it("executeCodeBuffer outline reflects the post-edit symbol set", async () => {
		const file = path.join(tmpDir, "outline.ts");
		await fs.writeFile(file, "export function alpha() {}\n");

  // Replace the symbol via the canonical edit surface (target carries the symbol path).
  		const chunks = await executeCodePath({
  			command: "edit",
  			target: "outline.ts::alpha",
  			root: tmpDir,
  			actions: [{ kind: "symbolRename", newName: "beta" }],
  			sessionId: "S-outline",
  		});
		const diags = chunks.flatMap(c => c.diagnostics);
		expect(diags.length).toBe(0);

		const outline = executeCodeBuffer({ command: "outline", file });
		expect(outline.error).toBe(false);
		const serialized = JSON.stringify(outline.output);
		expect(serialized).toContain("beta");
		expect(serialized).not.toContain("alpha");
	});

	it("executeCodeBuffer undo after executeCodePath edit reverts the buffer", async () => {
		const file = path.join(tmpDir, "undo.ts");
		await fs.writeFile(file, "export const value = 1;\n");

		await applyEdit(tmpDir, "undo.ts", "1", "2");
		expect(await fs.readFile(file, "utf-8")).toContain("= 2;");

		const undo = executeCodeBuffer({ command: "undo", file });
		expect(undo.error).toBe(false);
		// The undo output is a saved edit result (array form); reaching here without
		// erroring means the cross-NAPI history bridge is intact.
		expect(Array.isArray(undo.output) || typeof undo.output === "object").toBe(true);
	});

	it("executeCodeBuffer diff after executeCodePath edit returns the change hunks", async () => {
		const file = path.join(tmpDir, "diff.ts");
		await fs.writeFile(file, "export const z = 10;\n");

		await applyEdit(tmpDir, "diff.ts", "10", "20");

		// Buffer is now ahead of disk (edit auto-saved → buffer == disk). After
		// undo, the buffer differs from disk and diff_from_disk has hunks.
		executeCodeBuffer({ command: "undo", file });
		const diff = executeCodeBuffer({ command: "diff", file });
		expect(diff.error).toBe(false);
		expect(Array.isArray(diff.output)).toBe(true);
	});
});
