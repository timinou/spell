import { describe, expect, it } from "bun:test";
import { buildPullPlan } from "../../src/sync/pull";
import type { PullOptions } from "../../src/sync/types";

const baseOptions: PullOptions = {
	target: {
		name: "production",
		host: "spell.example.com",
		user: "spell",
		port: 22,
		projectRoot: "/srv/spell/app",
		include: [],
		exclude: [],
	},
	sync: {
		pushDebounce: "2s",
		pull: ["data/", "artifacts/"],
		pullInterval: "30s",
	},
	localRoot: "/workspace/app",
	dryRun: false,
};

describe("buildPullPlan", () => {
	it("builds one rsync command per pull directory with sqlite excludes", () => {
		const plan = buildPullPlan(baseOptions);

		expect(plan.rsyncCommands).toHaveLength(2);
		expect(plan.rsyncCommands[0]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/data/");
		expect(plan.rsyncCommands[1]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/artifacts/");

		// Each rsync command should exclude sqlite files
		for (const cmd of plan.rsyncCommands) {
			expect(cmd.args).toContain("--exclude");
			expect(cmd.args).toContain("*.sqlite");
			expect(cmd.args).toContain("*.sqlite-wal");
			expect(cmd.args).toContain("*.sqlite-shm");
		}
	});

	it("returns no rsync commands when no pull directories are configured", () => {
		const plan = buildPullPlan({
			...baseOptions,
			sync: {
				...baseOptions.sync,
				pull: [],
			},
		});

		expect(plan.rsyncCommands).toEqual([]);
		expect(plan.sqliteRsyncCommands).toEqual([]);
	});

	it("produces sqlite3-rsync commands when sqliteFiles are provided", () => {
		const plan = buildPullPlan({
			...baseOptions,
			sqliteFiles: ["data/main.sqlite", "data/logs.sqlite"],
		});

		expect(plan.sqliteRsyncCommands).toHaveLength(2);
		expect(plan.sqliteRsyncCommands[0]!.args).toContain("sqlite3-rsync");
		expect(plan.sqliteRsyncCommands[0]!.description).toBe("sqlite3-rsync pull data/main.sqlite");
		expect(plan.sqliteRsyncCommands[1]!.description).toBe("sqlite3-rsync pull data/logs.sqlite");
	});

	it("produces no sqlite3-rsync commands when sqliteFiles not provided", () => {
		const plan = buildPullPlan(baseOptions);

		expect(plan.sqliteRsyncCommands).toEqual([]);
	});
});
