import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite } from "../src/atomic-write";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-atomic-write-"));
});

afterEach(async () => {
	mock.restore();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function listTmpFiles(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async entry => {
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				return listTmpFiles(fullPath);
			}
			return entry.name.includes(".tmp") ? [fullPath] : [];
		}),
	);
	return nested.flat();
}

describe("atomicWrite", () => {
	test("handles two concurrent writes to the same path without ENOENT and leaves one complete payload", async () => {
		const filePath = path.join(tmpDir, "shared.org");
		const writeA = atomicWrite(filePath, "alpha content");
		const writeB = atomicWrite(filePath, "beta content");

		await expect(Promise.all([writeA, writeB])).resolves.toEqual([undefined, undefined]);

		const stat = await fs.stat(filePath);
		expect(stat.isFile()).toBe(true);

		const finalContent = await Bun.file(filePath).text();
		expect(["alpha content", "beta content"]).toContain(finalContent);
	});

	test("cleans up tmp file when rename fails", async () => {
		const existingDir = path.join(tmpDir, "target-dir");
		await fs.mkdir(existingDir);

		await expect(atomicWrite(existingDir, "will fail at rename")).rejects.toBeDefined();

		const tmpFiles = await listTmpFiles(tmpDir);
		expect(tmpFiles).toEqual([]);
	});

	test("leaves no tmp file behind after a successful write", async () => {
		const filePath = path.join(tmpDir, "clean-success.org");
		await atomicWrite(filePath, "stable output");

		const tmpFiles = await listTmpFiles(tmpDir);
		expect(tmpFiles).toEqual([]);
	});

	test("uses distinct tmp paths for concurrent writes", async () => {
		const filePath = path.join(tmpDir, "distinct.org");
		const observedTmpPaths: string[] = [];
		const originalRename = fs.rename.bind(fs);

		const renameSpy = spyOn(fs, "rename").mockImplementation(async (fromPath, toPath) => {
			if (typeof fromPath === "string" && fromPath.includes(".tmp")) {
				observedTmpPaths.push(fromPath);
			}
			return originalRename(fromPath, toPath);
		});

		try {
			await Promise.all([atomicWrite(filePath, "first"), atomicWrite(filePath, "second")]);
		} finally {
			renameSpy.mockRestore();
		}

		expect(observedTmpPaths).toHaveLength(2);
		expect(new Set(observedTmpPaths).size).toBe(2);
		for (const tmpPath of observedTmpPaths) {
			expect(tmpPath.startsWith(tmpDir)).toBe(true);
			expect(tmpPath).toContain(path.basename(filePath));
			expect(tmpPath).toContain(".tmp");
		}
	});
});
