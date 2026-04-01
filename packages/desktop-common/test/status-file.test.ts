import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StatusFileReader, StatusFileWriter } from "../src/status-file";

const TEST_DIR = path.join(os.tmpdir(), `spell-test-status-${process.pid}`);

beforeEach(async () => {
	await fs.mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("StatusFileWriter", () => {
	it("writes a status file and deduplicates identical writes", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(42);

		writer.writeIfChanged("running", "myapp", "session-1");
		// Allow async Bun.write to settle
		await Bun.sleep(50);

		const filePath = path.join(TEST_DIR, "42.json");
		const data = await Bun.file(filePath).json();
		expect(data.status).toBe("running");
		expect(data.windowId).toBe(42);
		expect(data.projectName).toBe("myapp");
		expect(data.sessionTitle).toBe("session-1");
		expect(data.pid).toBe(process.pid);

		// Second call with same dedup key should not rewrite
		const mtime1 = (await fs.stat(filePath)).mtimeMs;
		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);
		const mtime2 = (await fs.stat(filePath)).mtimeMs;
		expect(mtime2).toBe(mtime1);
	});

	it("writes when status changes", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(99);

		writer.writeIfChanged("idle", "proj", "s1");
		await Bun.sleep(50);
		let data = await Bun.file(path.join(TEST_DIR, "99.json")).json();
		expect(data.status).toBe("idle");

		writer.writeIfChanged("running", "proj", "s1");
		await Bun.sleep(50);
		data = await Bun.file(path.join(TEST_DIR, "99.json")).json();
		expect(data.status).toBe("running");
	});

	it("cleanup removes the status file", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(77);
		writer.writeIfChanged("idle", "p", "s");
		await Bun.sleep(50);

		await writer.cleanup();
		const exists = await Bun.file(path.join(TEST_DIR, "77.json")).exists();
		expect(exists).toBe(false);
	});
});

describe("StatusFileReader", () => {
	it("reads status files and filters stale (dead PID) entries", async () => {
		const reader = new StatusFileReader(TEST_DIR);

		// Write a file for the current (alive) PID
		await Bun.write(
			path.join(TEST_DIR, "1.json"),
			JSON.stringify({
				status: "running",
				windowId: 1,
				pid: process.pid,
				projectName: "a",
				sessionTitle: "s",
				updatedAt: Date.now(),
			}),
		);

		// Write a file for a dead PID
		await Bun.write(
			path.join(TEST_DIR, "2.json"),
			JSON.stringify({
				status: "idle",
				windowId: 2,
				pid: 999999,
				projectName: "b",
				sessionTitle: "s",
				updatedAt: Date.now(),
			}),
		);

		const results = await reader.readAll();
		expect(results).toHaveLength(1);
		expect(results[0].windowId).toBe(1);
	});

	it("returns empty array when directory does not exist", async () => {
		const reader = new StatusFileReader("/nonexistent/path/spell-test");
		const results = await reader.readAll();
		expect(results).toEqual([]);
	});
});
