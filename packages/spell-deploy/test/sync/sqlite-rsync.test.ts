import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSqliteRsyncCommands,
	buildSshWrapperScript,
	cleanupSshWrapper,
	discoverLocalSqliteFiles,
	writeSshWrapper,
} from "../../src/sync/sqlite-rsync";
import type { SshOptions } from "../../src/sync/types";

const sshOptions: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 2222,
	sshKey: "~/.ssh/id_ed25519",
	connectTimeout: 10,
};

const defaultSshOptions: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 22,
	connectTimeout: 10,
};

describe("buildSshWrapperScript", () => {
	it("returns null when port is 22 and no SSH key", () => {
		expect(buildSshWrapperScript(defaultSshOptions)).toBeNull();
	});

	it("generates wrapper script with custom port and key", () => {
		const script = buildSshWrapperScript(sshOptions)!;

		expect(script).toStartWith("#!/bin/sh\n");
		expect(script).toContain("-p 2222");
		expect(script).toContain("-i '~/.ssh/id_ed25519'");
		expect(script).toContain("StrictHostKeyChecking=accept-new");
		expect(script).toContain(`ConnectTimeout=${sshOptions.connectTimeout}`);
		expect(script).toContain('"$@"');
	});

	it("generates wrapper with custom port but no key", () => {
		const script = buildSshWrapperScript({ ...defaultSshOptions, port: 2222 })!;

		expect(script).toContain("-p 2222");
		expect(script).not.toContain("-i ");
	});

	it("generates wrapper with key but default port", () => {
		const script = buildSshWrapperScript({ ...defaultSshOptions, sshKey: "/my/key" })!;

		expect(script).toContain("-i '/my/key'");
	});
});

describe("buildSqliteRsyncCommands", () => {
	it("builds pull commands with correct source/dest order", () => {
		const commands = buildSqliteRsyncCommands({
			sshOptions,
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			sqliteFiles: ["data/main.sqlite", "data/logs.sqlite"],
			direction: "pull",
			sshWrapperPath: "/tmp/wrapper",
		});

		expect(commands).toHaveLength(2);
		expect(commands[0]!.args).toEqual([
			"sqlite3-rsync",
			"--ssh",
			"/tmp/wrapper",
			"spell@spell.example.com:/srv/spell/app/data/main.sqlite",
			"/workspace/app/data/main.sqlite",
		]);
		expect(commands[0]!.description).toBe("sqlite3-rsync pull data/main.sqlite");
	});

	it("builds push commands with correct source/dest order", () => {
		const commands = buildSqliteRsyncCommands({
			sshOptions,
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			sqliteFiles: ["data/main.sqlite"],
			direction: "push",
			sshWrapperPath: "/tmp/wrapper",
		});

		expect(commands[0]!.args).toEqual([
			"sqlite3-rsync",
			"--ssh",
			"/tmp/wrapper",
			"/workspace/app/data/main.sqlite",
			"spell@spell.example.com:/srv/spell/app/data/main.sqlite",
		]);
		expect(commands[0]!.description).toBe("sqlite3-rsync push data/main.sqlite");
	});

	it("omits --ssh flag when no wrapper path provided", () => {
		const commands = buildSqliteRsyncCommands({
			sshOptions: defaultSshOptions,
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			sqliteFiles: ["data/main.sqlite"],
			direction: "pull",
		});

		expect(commands[0]!.args).toEqual([
			"sqlite3-rsync",
			"spell@spell.example.com:/srv/spell/app/data/main.sqlite",
			"/workspace/app/data/main.sqlite",
		]);
	});

	it("returns empty array for no sqlite files", () => {
		const commands = buildSqliteRsyncCommands({
			sshOptions,
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			sqliteFiles: [],
			direction: "pull",
		});

		expect(commands).toEqual([]);
	});
});

describe("discoverLocalSqliteFiles", () => {
	it("finds sqlite files in nested directories", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-sqlite-test-"));
		try {
			// Create test structure
			const dataDir = path.join(tmpDir, "data");
			await fs.mkdir(dataDir, { recursive: true });
			await Bun.write(path.join(dataDir, "main.sqlite"), "");
			await Bun.write(path.join(dataDir, "logs.sqlite"), "");
			await Bun.write(path.join(dataDir, "config.json"), "");

			const files = await discoverLocalSqliteFiles({
				localRoot: tmpDir,
				dirs: ["data/"],
			});

			expect(files.sort()).toEqual(["data/logs.sqlite", "data/main.sqlite"]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when directory does not exist", async () => {
		const files = await discoverLocalSqliteFiles({
			localRoot: "/nonexistent",
			dirs: ["data/"],
		});

		expect(files).toEqual([]);
	});

	it("returns empty array for empty dirs list", async () => {
		const files = await discoverLocalSqliteFiles({
			localRoot: "/workspace/app",
			dirs: [],
		});

		expect(files).toEqual([]);
	});
});

describe("writeSshWrapper / cleanupSshWrapper", () => {
	it("writes an executable wrapper and cleans it up", async () => {
		const wrapperPath = await writeSshWrapper(sshOptions);
		expect(wrapperPath).not.toBeNull();

		const content = await Bun.file(wrapperPath!).text();
		expect(content).toStartWith("#!/bin/sh\n");

		const stat = await fs.stat(wrapperPath!);
		expect(stat.mode & 0o755).toBe(0o755);

		await cleanupSshWrapper(wrapperPath);
		const exists = await Bun.file(wrapperPath!).exists();
		expect(exists).toBe(false);
	});

	it("returns null when no wrapper needed", async () => {
		const wrapperPath = await writeSshWrapper(defaultSshOptions);
		expect(wrapperPath).toBeNull();
	});

	it("cleanupSshWrapper handles null gracefully", async () => {
		// Should not throw
		await cleanupSshWrapper(null);
	});
});
