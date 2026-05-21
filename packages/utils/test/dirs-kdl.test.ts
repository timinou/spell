/**
 * Tests for the KDL config file path helpers added to dirs.ts.
 *
 * These are the foundation of the four-tier settings model. They MUST NOT
 * couple to getAgentDir() — the user-tier KDL lives at the XDG-style location
 * while runtime state (sessions/plugins/logs) continues under ~/.spell/.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	getLegacyUserKdlPath,
	getLocalKdlPath,
	getProjectKdlPath,
	getUserKdlPath,
} from "@oh-my-pi/pi-utils/dirs";

const ORIGINAL_ENV = {
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_USER_KDL: process.env.PI_USER_KDL,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("getUserKdlPath", () => {
	beforeEach(() => {
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.PI_USER_KDL;
	});
	afterEach(restoreEnv);

	it("defaults to ~/.config/spell/spell.kdl", () => {
		expect(getUserKdlPath()).toBe(path.join(os.homedir(), ".config", "spell", "spell.kdl"));
	});

	it("honors XDG_CONFIG_HOME when set", () => {
		process.env.XDG_CONFIG_HOME = "/custom/xdg";
		expect(getUserKdlPath()).toBe("/custom/xdg/spell/spell.kdl");
	});

	it("honors PI_USER_KDL override (absolute) above XDG", () => {
		process.env.XDG_CONFIG_HOME = "/custom/xdg";
		process.env.PI_USER_KDL = "/opt/spell.kdl";
		expect(getUserKdlPath()).toBe("/opt/spell.kdl");
	});

	it("resolves PI_USER_KDL relative paths against cwd", () => {
		process.env.PI_USER_KDL = "relative/spell.kdl";
		expect(getUserKdlPath()).toBe(path.resolve("relative/spell.kdl"));
	});

	it("ignores empty XDG_CONFIG_HOME (treats as unset)", () => {
		process.env.XDG_CONFIG_HOME = "";
		expect(getUserKdlPath()).toBe(path.join(os.homedir(), ".config", "spell", "spell.kdl"));
	});

	it("ignores empty PI_USER_KDL (treats as unset)", () => {
		process.env.PI_USER_KDL = "";
		expect(getUserKdlPath()).toBe(path.join(os.homedir(), ".config", "spell", "spell.kdl"));
	});

	it("is decoupled from PI_CODING_AGENT_DIR (state vs config separation)", () => {
		process.env.PI_CODING_AGENT_DIR = "/elsewhere/agent";
		// User KDL must NOT shift just because the agent (state) dir moved.
		expect(getUserKdlPath()).toBe(path.join(os.homedir(), ".config", "spell", "spell.kdl"));
	});
});

describe("getProjectKdlPath", () => {
	it("resolves to <cwd>/spell.kdl when cwd given", () => {
		expect(getProjectKdlPath("/work/repo")).toBe("/work/repo/spell.kdl");
	});

	it("defaults to current project dir when cwd omitted", () => {
		const result = getProjectKdlPath();
		expect(result.endsWith(`${path.sep}spell.kdl`)).toBe(true);
	});
});

describe("getLocalKdlPath", () => {
	it("resolves to <cwd>/.local/spell.kdl when cwd given", () => {
		expect(getLocalKdlPath("/work/repo")).toBe("/work/repo/.local/spell.kdl");
	});

	it("places .local under the project root, not under cwd's parent", () => {
		expect(getLocalKdlPath("/a/b/c")).toBe("/a/b/c/.local/spell.kdl");
	});
});

describe("getLegacyUserKdlPath", () => {
	beforeEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});
	afterEach(restoreEnv);

	it("defaults to ~/.spell/spell.kdl (parent of default agentDir)", () => {
		expect(getLegacyUserKdlPath()).toBe(path.join(os.homedir(), ".spell", "spell.kdl"));
	});

	it("differs from getUserKdlPath — required for the migrator", () => {
		// Migrator reads legacy, writes forward. Equality would defeat its purpose.
		expect(getLegacyUserKdlPath()).not.toBe(getUserKdlPath());
	});
});
