import { describe, expect, it } from "bun:test";
import { buildInstallUnitCommand, buildServiceCommand } from "../../src/service/lifecycle";
import { buildUnitConfig, generateSystemdUnit } from "../../src/service/systemd";
import type { SshOptions } from "../../src/sync/types";

const sshOptions: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 2222,
	sshKey: "~/.ssh/id_ed25519",
	connectTimeout: 10,
};

const unitConfig = buildUnitConfig({
	unitName: "spell-growth",
	projectRoot: "/srv/spell/app",
	bundlePath: "/srv/spell/app/.spell/bundle/spell",
	user: "spell",
});

describe("systemd unit generation", () => {
	it("includes the bundle path in ExecStart", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("ExecStart=/srv/spell/app/.spell/bundle/spell server start");
	});

	it("includes NoNewPrivileges=true", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("NoNewPrivileges=true");
	});

	it("includes ProtectSystem=strict", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("ProtectSystem=strict");
	});

	it("includes ProtectHome=true", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("ProtectHome=true");
	});

	it("includes PrivateTmp=true", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("PrivateTmp=true");
	});

	it("includes MemoryDenyWriteExecute=false for Bun JIT", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("MemoryDenyWriteExecute=false");
	});

	it("scopes ReadWritePaths to the project directory", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("ReadWritePaths=/srv/spell/app");
	});

	it("joins multiple ReadWritePaths", () => {
		const unit = generateSystemdUnit({
			...unitConfig,
			readWritePaths: ["/srv/spell/app", "/srv/spell/app/data"],
		});

		expect(unit).toContain("ReadWritePaths=/srv/spell/app /srv/spell/app/data");
	});

	it("points EnvironmentFile at the project .env", () => {
		const unit = generateSystemdUnit(unitConfig);

		expect(unit).toContain("EnvironmentFile=/srv/spell/app/.env");
	});

	it("sanitizes unit names when building config", () => {
		const config = buildUnitConfig({
			unitName: "spell growth/blue",
			projectRoot: "/srv/spell/app",
			bundlePath: "/srv/spell/app/.spell/bundle/spell",
			user: "spell",
		});

		expect(config.unitName).toBe("spell-growth-blue");
	});

	it("builds unit config from project params", () => {
		expect(unitConfig).toEqual({
			unitName: "spell-growth",
			execStart: "/srv/spell/app/.spell/bundle/spell",
			workingDirectory: "/srv/spell/app",
			environmentFile: "/srv/spell/app/.env",
			readWritePaths: ["/srv/spell/app"],
			user: "spell",
			group: "spell",
		});
	});
});

describe("service lifecycle commands", () => {
	it("builds a start systemctl SSH command", () => {
		const command = buildServiceCommand(sshOptions, "spell-growth", "start");

		expect(command.args).toEqual([
			"ssh",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-p",
			"2222",
			"-i",
			"~/.ssh/id_ed25519",
			"spell@spell.example.com",
			"sudo systemctl start spell-growth",
		]);
	});

	it("builds a restart systemctl SSH command", () => {
		const command = buildServiceCommand(sshOptions, "spell-growth", "restart");

		expect(command.args.at(-1)).toBe("sudo systemctl restart spell-growth");
		expect(command.description).toBe("SSH: sudo systemctl restart spell-growth");
	});

	it("builds an install command that writes the unit via sudo tee", () => {
		const unitContent = generateSystemdUnit(unitConfig);
		const command = buildInstallUnitCommand(sshOptions, unitContent, "spell-growth");

		expect(command.args).toEqual([
			"ssh",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-p",
			"2222",
			"-i",
			"~/.ssh/id_ed25519",
			"spell@spell.example.com",
			"sudo tee /etc/systemd/system/spell-growth.service > /dev/null && sudo systemctl daemon-reload",
		]);
		expect(command.stdin).toBe(unitContent);
		expect(command.description).toBe("Install systemd unit spell-growth");
	});

	it("sanitizes shell metacharacters in unit name for systemctl", () => {
		const command = buildServiceCommand(sshOptions, "foo; rm -rf /", "start");
		const remoteCmd = command.args.at(-1) ?? "";

		expect(remoteCmd).not.toContain(";");
		expect(remoteCmd).toBe("sudo systemctl start foo-rm--rf-");
	});

	it("sanitizes unit name in install command remote path", () => {
		const command = buildInstallUnitCommand(sshOptions, "[Unit]\n", "evil;name");
		const remoteCmd = command.args.at(-1) ?? "";

		expect(remoteCmd).toContain("/etc/systemd/system/evil-name.service");
		expect(remoteCmd).not.toContain(";");
	});
});
