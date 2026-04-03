import { describe, expect, it } from "bun:test";
import { buildPullRsyncArgs, buildPushRsyncArgs } from "../../src/sync/rsync";
import type { SshOptions } from "../../src/sync/types";

const sshOptions: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 2222,
	sshKey: "~/.ssh/id_ed25519",
	connectTimeout: 10,
};

describe("rsync command builders", () => {
	it("builds push rsync args with SSH transport port and key", () => {
		const command = buildPushRsyncArgs({
			sshOptions,
			localRoot: "/tmp/build",
			remoteStaging: "/srv/spell/app.staging",
			include: [],
			exclude: [],
		});

		expect(command.args).toContain("rsync");
		expect(command.args).toContain("-e");
		expect(command.args).toContain(
			"ssh -p 2222 -i '~/.ssh/id_ed25519' -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
		);
	});

	it("builds push rsync args with include and exclude filters", () => {
		const command = buildPushRsyncArgs({
			sshOptions,
			localRoot: "/tmp/build",
			remoteStaging: "/srv/spell/app.staging",
			include: ["src/", "package.json"],
			exclude: ["node_modules/", ".git/"],
		});

		expect(command.args).toEqual([
			"rsync",
			"-avz",
			"--delete",
			"-e",
			"ssh -p 2222 -i '~/.ssh/id_ed25519' -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
			"--include",
			"src/",
			"--include",
			"package.json",
			"--exclude",
			"node_modules/",
			"--exclude",
			".git/",
			"/tmp/build/",
			"spell@spell.example.com:/srv/spell/app.staging/",
		]);
	});

	it("uses a trailing slash on push source", () => {
		const command = buildPushRsyncArgs({
			sshOptions,
			localRoot: "/tmp/build",
			remoteStaging: "/srv/spell/app.staging",
			include: [],
			exclude: [],
		});

		expect(command.args.at(-2)).toBe("/tmp/build/");
	});

	it("builds one pull command per directory", () => {
		const commands = buildPullRsyncArgs({
			sshOptions,
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			pullDirs: ["data/", "artifacts/"],
		});

		expect(commands).toHaveLength(2);
		expect(commands[0]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/data/");
		expect(commands[1]?.args.at(-2)).toBe("spell@spell.example.com:/srv/spell/app/artifacts/");
	});

	it("omits SSH key from pull transport when not configured", () => {
		const commands = buildPullRsyncArgs({
			sshOptions: {
				host: "spell.example.com",
				user: "spell",
				port: 22,
				connectTimeout: 10,
			},
			remoteProjectRoot: "/srv/spell/app",
			localRoot: "/workspace/app",
			pullDirs: ["data/"],
		});

		expect(commands[0]?.args).toContain("ssh -p 22 -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10");
		expect(commands[0]?.args.join(" ")).not.toContain(" -i ");
	});

	it("quotes SSH key path containing spaces in -e transport", () => {
		const command = buildPushRsyncArgs({
			sshOptions: {
				host: "example.com",
				user: "deploy",
				port: 22,
				sshKey: "/home/user/.ssh/my key",
				connectTimeout: 10,
			},
			localRoot: "/tmp/build",
			remoteStaging: "/srv/app.staging",
			include: [],
			exclude: [],
		});

		expect(command.args).toContain(
			"ssh -p 22 -i '/home/user/.ssh/my key' -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
		);
	});
});
