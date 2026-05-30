import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import { StatusFileReader, StatusFileWriter } from "../src/status-file";

const TEST_DIR = path.join(os.tmpdir(), `spell-test-status-${process.pid}`);

beforeEach(async () => {
	await fs.mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("StatusFileWriter", () => {
	it("writes a status file and deduplicates identical writes", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(42);

		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		const filePath = path.join(TEST_DIR, "42.json");
		const data = await Bun.file(filePath).json();
		expect(data.status).toBe("running");
		expect(data.windowId).toBe(42);
		expect(data.projectName).toBe("myapp");
		expect(data.sessionTitle).toBe("session-1");
		expect(data.pid).toBe(process.pid);

		const mtime1 = (await fs.stat(filePath)).mtimeMs;
		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);
		const mtime2 = (await fs.stat(filePath)).mtimeMs;
		expect(mtime2).toBe(mtime1);
	});

	it("includes recovery metadata when provided", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(43);
		writer.setSessionInfo({
			sessionId: "session-123",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
		});
		writer.setWorkspaceName("workspace-dev");

		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		const data = await Bun.file(path.join(TEST_DIR, "43.json")).json();
		expect(data.sessionId).toBe("session-123");
		expect(data.sessionFile).toBe("/tmp/session.jsonl");
		expect(data.cwd).toBe("/tmp/project");
		expect(data.workspaceName).toBe("workspace-dev");
	});

	it("re-writes when recovery metadata is set after the initial write", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(50);

		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		let data = await Bun.file(path.join(TEST_DIR, "50.json")).json();
		expect(data.sessionId).toBeUndefined();
		expect(data.cwd).toBeUndefined();

		writer.setSessionInfo({
			sessionId: "sess-50",
			sessionFile: "/tmp/sess-50.jsonl",
			cwd: "/work/myapp",
		});
		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		data = await Bun.file(path.join(TEST_DIR, "50.json")).json();
		expect(data.sessionId).toBe("sess-50");
		expect(data.cwd).toBe("/work/myapp");
	});

	it("re-writes when workspace name is set after the initial write", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(51);

		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		let data = await Bun.file(path.join(TEST_DIR, "51.json")).json();
		expect(data.workspaceName).toBeUndefined();

		writer.setWorkspaceName("ws-dev");
		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(50);

		data = await Bun.file(path.join(TEST_DIR, "51.json")).json();
		expect(data.workspaceName).toBe("ws-dev");
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
	it("logs write failures instead of swallowing them", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(88);
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		spyOn(Bun, "write").mockImplementation(() => Promise.reject(new Error("disk full")));

		writer.writeIfChanged("running", "myapp", "session-1");
		await Bun.sleep(0);

		expect(warnSpy).toHaveBeenCalledWith(
			"StatusFileWriter: write failed",
			expect.objectContaining({
				path: path.join(TEST_DIR, "88.json"),
				err: "Error: disk full",
			}),
		);
	});

	it("logs cleanup failures instead of swallowing them", async () => {
		const writer = new StatusFileWriter(TEST_DIR);
		writer.setWindowId(89);
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		spyOn(fs, "rm").mockImplementation(async targetPath => {
			if (String(targetPath) === path.join(TEST_DIR, "89.json")) {
				throw new Error("permission denied");
			}
		});

		await writer.cleanup();

		expect(warnSpy).toHaveBeenCalledWith(
			"StatusFileWriter: cleanup failed",
			expect.objectContaining({
				path: path.join(TEST_DIR, "89.json"),
				err: "Error: permission denied",
			}),
		);
	});
});

describe("StatusFileReader", () => {
	it("reads status files and filters stale (dead PID) entries", async () => {
		const reader = new StatusFileReader(TEST_DIR);

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
		expect(await Bun.file(path.join(TEST_DIR, "2.json")).exists()).toBe(false);
	});

	it("reads crashed sessions without deleting their status files", async () => {
		const reader = new StatusFileReader(TEST_DIR);

		await Bun.write(
			path.join(TEST_DIR, "2.json"),
			JSON.stringify({
				status: "idle",
				windowId: 2,
				pid: 999999,
				projectName: "b",
				sessionTitle: "s",
				updatedAt: Date.now(),
				sessionId: "session-2",
				cwd: "/tmp/project",
			}),
		);

		const results = await reader.readCrashed();
		expect(results).toHaveLength(1);
		expect(results[0].sessionId).toBe("session-2");
		expect(await Bun.file(path.join(TEST_DIR, "2.json")).exists()).toBe(true);
	});

	it("removes only dead status files that cannot be recovered", async () => {
		const reader = new StatusFileReader(TEST_DIR);
		await Bun.write(
			path.join(TEST_DIR, "3.json"),
			JSON.stringify({
				status: "running",
				windowId: 3,
				pid: 999999,
				projectName: "stale",
				sessionTitle: "missing-metadata",
				updatedAt: Date.now(),
			}),
		);
		await Bun.write(
			path.join(TEST_DIR, "4.json"),
			JSON.stringify({
				status: "running",
				windowId: 4,
				pid: 999999,
				projectName: "recoverable",
				sessionTitle: "resume-me",
				updatedAt: Date.now(),
				sessionId: "sess-4",
				cwd: "/tmp/project-4",
			}),
		);
		await Bun.write(
			path.join(TEST_DIR, "5.json"),
			JSON.stringify({
				status: "running",
				windowId: 5,
				pid: process.pid,
				projectName: "live",
				sessionTitle: "keep-me",
				updatedAt: Date.now(),
			}),
		);

		const cleaned = await reader.cleanStale();
		expect(cleaned).toBe(1);
		expect(await Bun.file(path.join(TEST_DIR, "3.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(TEST_DIR, "4.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(TEST_DIR, "5.json")).exists()).toBe(true);
	});

	it("logs stale cleanup failures and continues", async () => {
		const reader = new StatusFileReader(TEST_DIR);
		const stalePath = path.join(TEST_DIR, "6.json");
		await Bun.write(
			stalePath,
			JSON.stringify({
				status: "running",
				windowId: 6,
				pid: 999999,
				projectName: "stale",
				sessionTitle: "permission-error",
				updatedAt: Date.now(),
			}),
		);
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		spyOn(fs, "rm").mockImplementation(async targetPath => {
			if (String(targetPath) === stalePath) {
				throw new Error("permission denied");
			}
		});

		const cleaned = await reader.cleanStale();
		expect(cleaned).toBe(0);
		expect(warnSpy).toHaveBeenCalledWith(
			"StatusFileReader: stale cleanup failed",
			expect.objectContaining({
				path: stalePath,
				err: "Error: permission denied",
			}),
		);
	});

	it("keeps backwards compatibility with older status files", async () => {
		const reader = new StatusFileReader(TEST_DIR);

		await Bun.write(
			path.join(TEST_DIR, "1.json"),
			JSON.stringify({
				status: "running",
				windowId: 1,
				pid: process.pid,
				projectName: "legacy",
				sessionTitle: "old-session",
				updatedAt: Date.now(),
			}),
		);

		const results = await reader.readAll();
		expect(results).toHaveLength(1);
		expect(results[0].sessionId).toBeUndefined();
		expect(results[0].workspaceName).toBeUndefined();
	});

	it("returns empty array when directory does not exist", async () => {
		const reader = new StatusFileReader("/nonexistent/path/spell-test");
		expect(await reader.readAll()).toEqual([]);
		expect(await reader.readCrashed()).toEqual([]);
		expect(await reader.cleanStale()).toBe(0);
	});
});
