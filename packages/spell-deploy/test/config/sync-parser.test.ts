import { describe, expect, it } from "bun:test";
import { parseSyncConfig } from "../../src/config/sync-parser";

const fullSyncKdl = `default-target "production"

target "production" {
	host "spell.example.com"
	user "spell"
	port 22
	ssh-key "~/.ssh/id_ed25519"
	project-root "/srv/spell/growth"
	service type="systemd" unit="spell-growth"
	secrets ".spell/secrets/production.env.age"
	include "src/" "package.json" "bun.lock"
	exclude "node_modules/" ".git/" "*.sqlite" "*.sqlite-wal" ".env"
}

sync {
	push-debounce "2s"
	pull "data/" "artifacts/" "shared-sync/"
	pull-interval "30s"
}

bundle {
	platform "linux-x64"
	cache-dir ".spell/bundle-cache/"
}
`;

describe("parseSyncConfig", () => {
	it("parses full sync.kdl", () => {
		const config = parseSyncConfig(fullSyncKdl);
		const target = config.targets.get("production");

		expect(config.defaultTarget).toBe("production");
		expect(config.targets.size).toBe(1);
		expect(target).toEqual({
			name: "production",
			host: "spell.example.com",
			user: "spell",
			port: 22,
			sshKey: "~/.ssh/id_ed25519",
			projectRoot: "/srv/spell/growth",
			service: {
				type: "systemd",
				unit: "spell-growth",
			},
			secrets: ".spell/secrets/production.env.age",
			include: ["src/", "package.json", "bun.lock"],
			exclude: ["node_modules/", ".git/", "*.sqlite", "*.sqlite-wal", ".env"],
		});
		expect(config.sync).toEqual({
			pushDebounce: "2s",
			pull: ["data/", "artifacts/", "shared-sync/"],
			pullInterval: "30s",
		});
		expect(config.bundle).toEqual({
			platform: "linux-x64",
			cacheDir: ".spell/bundle-cache/",
		});
	});

	it("parses minimal sync.kdl with defaults", () => {
		const config = parseSyncConfig(`target "production" {
			host "spell.example.com"
			project-root "/srv/spell/growth"
		}`);

		expect(config.defaultTarget).toBe("production");
		expect(config.targets.get("production")).toEqual({
			name: "production",
			host: "spell.example.com",
			user: "root",
			port: 22,
			projectRoot: "/srv/spell/growth",
			include: [],
			exclude: [],
		});
		expect(config.sync).toEqual({
			pushDebounce: "2s",
			pull: [],
			pullInterval: "30s",
		});
		expect(config.bundle).toEqual({
			platform: "linux-x64",
			cacheDir: ".spell/bundle-cache/",
		});
	});

	it("rejects missing host", () => {
		expect(() =>
			parseSyncConfig(`target "production" {
				project-root "/srv/spell/growth"
			}`),
		).toThrow("sync.targets.production.host is required");
	});

	it("rejects missing project-root", () => {
		expect(() =>
			parseSyncConfig(`target "production" {
				host "spell.example.com"
			}`),
		).toThrow("sync.targets.production.projectRoot is required");
	});

	it("supports multiple targets and explicit default-target", () => {
		const config = parseSyncConfig(`default-target "staging"

			target "production" {
				host "spell.example.com"
				project-root "/srv/spell/growth"
			}

			target "staging" {
				host "staging.example.com"
				project-root "/srv/spell/staging"
			}`);

		expect(config.defaultTarget).toBe("staging");
		expect(config.targets.get("production")?.host).toBe("spell.example.com");
		expect(config.targets.get("staging")?.projectRoot).toBe("/srv/spell/staging");
	});

	it("rejects invalid default-target", () => {
		expect(() =>
			parseSyncConfig(`default-target "staging"

			target "production" {
				host "spell.example.com"
				project-root "/srv/spell/growth"
			}`),
		).toThrow("default-target references unknown target: staging");
	});

	it("parses service config from properties", () => {
		const config = parseSyncConfig(`target "production" {
			host "spell.example.com"
			project-root "/srv/spell/growth"
			service type="systemd" unit="spell-growth"
		}`);

		expect(config.targets.get("production")?.service).toEqual({
			type: "systemd",
			unit: "spell-growth",
		});
	});

	it("rejects duplicate target names", () => {
		expect(() =>
			parseSyncConfig(`target "production" {
				host "spell.example.com"
				project-root "/srv/spell/growth"
			}

			target "production" {
				host "staging.example.com"
				project-root "/srv/spell/staging"
			}`),
		).toThrow("Duplicate target name: production");
	});
});
