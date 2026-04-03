import { describe, expect, it } from "bun:test";
import { buildPushPlan } from "../../src/sync/push";
import type { PushOptions } from "../../src/sync/types";

const pushOptions: PushOptions = {
	target: {
		name: "production",
		host: "spell.example.com",
		user: "spell",
		port: 22,
		sshKey: "~/.ssh/id_ed25519",
		projectRoot: "/srv/spell/app",
		include: ["src/", "package.json"],
		exclude: ["node_modules/", ".git/"],
	},
	localRoot: "/workspace/app",
	dryRun: false,
};

describe("buildPushPlan", () => {
	it("uses projectRoot.staging as the staging directory", () => {
		const plan = buildPushPlan(pushOptions);

		expect(plan.rsyncToStaging.args.at(-1)).toBe("spell@spell.example.com:/srv/spell/app.staging/");
	});

	it("builds four swap commands in the required order", () => {
		const plan = buildPushPlan(pushOptions);
		const remoteCommands = plan.swapCommands.map(command => command.args.at(-1));

		expect(plan.swapCommands).toHaveLength(4);
		expect(remoteCommands).toEqual([
			"mkdir -p '/srv/spell/app.staging'",
			"rm -rf '/srv/spell/app.old'",
			"mv '/srv/spell/app' '/srv/spell/app.old' 2>/dev/null || true",
			"mv '/srv/spell/app.staging' '/srv/spell/app'",
		]);
	});

	it("targets the staging directory for rsync", () => {
		const plan = buildPushPlan(pushOptions);

		expect(plan.rsyncToStaging.args).toContain("spell@spell.example.com:/srv/spell/app.staging/");
	});

	it("never adds service lifecycle commands to the swap plan", () => {
		const plan = buildPushPlan(pushOptions);
		const combined = plan.swapCommands.map(command => command.args.at(-1) ?? "").join("\n");

		expect(combined).not.toContain("systemctl");
		expect(combined).not.toContain("service");
		expect(combined).not.toContain(" stop ");
		expect(combined).not.toContain(" start ");
		expect(combined).not.toContain(" restart ");
	});
});
