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
		sqliteBackup: true,
	},
	localRoot: "/workspace/app",
	dryRun: false,
};

describe("buildPullPlan", () => {
	it("includes a backup command when sqliteBackup is enabled", () => {
		const plan = buildPullPlan(baseOptions);

		expect(plan.backupCommand).toBeDefined();
		expect(plan.backupCommand?.args.at(-1)).toContain("sqlite3");
		expect(plan.backupCommand?.args.at(-1)).toContain("mkdir -p backups");
	});

	it("omits the backup command when sqliteBackup is disabled", () => {
		const plan = buildPullPlan({
			...baseOptions,
			sync: {
				...baseOptions.sync,
				sqliteBackup: false,
			},
		});

		expect(plan.backupCommand).toBeUndefined();
	});

	it("builds one rsync command per pull directory", () => {
		const plan = buildPullPlan(baseOptions);

		expect(plan.rsyncCommands).toHaveLength(2);
		expect(plan.rsyncCommands[0]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/data/");
		expect(plan.rsyncCommands[1]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/artifacts/");
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
	});
});
