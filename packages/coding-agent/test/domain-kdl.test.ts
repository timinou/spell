/**
 * Domain detection: spell.kdl is the canonical source.
 *
 * PLAN-311 WAVE 2b removed the legacy `.spell/domain.json` fallback. The
 * one-shot migrator translates pre-existing domain.json into the spell.kdl
 * `domain` node.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { detectDomain } from "@oh-my-pi/pi-coding-agent/domain/detection";
import { Snowflake } from "@oh-my-pi/pi-utils";

let tmp: string;
let projectDir: string;
let agentDir: string;
let userKdl: string;
let projectKdl: string;
let localKdl: string;

function initOptions() {
	return { cwd: projectDir, agentDir, userKdlPath: userKdl, projectKdlPath: projectKdl, localKdlPath: localKdl };
}

beforeEach(() => {
	_resetSettingsForTest();
	tmp = path.join(os.tmpdir(), "domain-kdl", Snowflake.next());
	projectDir = path.join(tmp, "project");
	agentDir = path.join(tmp, ".spell", "agent");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	userKdl = path.join(tmp, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
});

describe("detectDomain (post-WAVE-2b)", () => {
	it("returns 'coding' default when no config exists", async () => {
		expect(await detectDomain(projectDir)).toBe("coding");
	});

	it("CLI override wins over everything", async () => {
		fs.writeFileSync(projectKdl, 'domain "research"\n');
		expect(await detectDomain(projectDir, "writing")).toBe("writing");
	});

	it("reads `domain` from spell.kdl", async () => {
		fs.writeFileSync(projectKdl, 'domain "research"\n');
		expect(await detectDomain(projectDir)).toBe("research");
	});

	it("ignores legacy .spell/domain.json (no longer a fallback)", async () => {
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".spell", "domain.json"), JSON.stringify({ domain: "research" }));
		// No spell.kdl, no override → default ("coding"). The .json file is
		// invisible to detectDomain (but it logs an orphan-warning).
		expect(await detectDomain(projectDir)).toBe("coding");
	});

	it("[P2.2] spell.kdl-defined domain wins; orphan domain.json is benign", async () => {
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".spell", "domain.json"), JSON.stringify({ domain: "orphan-value" }));
		fs.writeFileSync(projectKdl, 'domain "primary"\n');
		// spell.kdl wins; orphan domain.json is invisible AND not warned about
		// (the warning only fires when the default would be returned).
		expect(await detectDomain(projectDir)).toBe("primary");
	});

	it("broken KDL falls back to default", async () => {
		fs.writeFileSync(projectKdl, "this is { not valid kdl!");
		expect(await detectDomain(projectDir)).toBe("coding");
	});
});

describe("Settings.get('domain') round-trip", () => {
	it("set/flush/reload preserves domain through spell.kdl", async () => {
		const s = await Settings.init(initOptions());
		s.set("domain", "research", "project");
		await s.flush();

		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		expect(s2.get("domain")).toBe("research");

		// detectDomain agrees.
		expect(await detectDomain(projectDir)).toBe("research");
	});
});

describe("Migrator: domain.json → spell.kdl", () => {
	it("translates project-level domain.json into the spell.kdl domain node", async () => {
		const legacy = path.join(projectDir, ".spell", "domain.json");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, JSON.stringify({ domain: "research" }));

		const s = await Settings.init({ ...initOptions(), migrate: { yes: true } });
		expect(s.get("domain")).toBe("research");

		// detectDomain sees the migrated value.
		expect(await detectDomain(projectDir)).toBe("research");

		// Source moved to .bak (idempotency on subsequent launches).
		expect(fs.existsSync(legacy)).toBe(false);
	});
});
