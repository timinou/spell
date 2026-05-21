/**
 * `spell config doctor` and `spell config show` smoke tests.
 *
 * WAVE 4 of PLAN-311. Doctor uses the migrator's detect.ts under a dynamic
 * import so it degrades gracefully after the migrator is removed.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

let tmp: string;

beforeEach(() => {
	tmp = path.join(os.tmpdir(), "config-cli-doctor", Snowflake.next());
	fs.mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
	if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
});

describe("config doctor: detect.ts dynamic import contract", () => {
	it("detectLegacyConfig is importable from the migration module", async () => {
		const mod = await import("@oh-my-pi/pi-coding-agent/migration/detect");
		expect(typeof mod.detectLegacyConfig).toBe("function");
	});

	it("returns empty findings for a clean directory", async () => {
		const { detectLegacyConfig } = await import("@oh-my-pi/pi-coding-agent/migration/detect");
		const projectDir = path.join(tmp, "project");
		const agentDir = path.join(tmp, ".spell", "agent");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const result = await detectLegacyConfig({
			cwd: projectDir,
			agentDir,
			userKdlDest: path.join(tmp, "user.kdl"),
			projectKdlDest: path.join(projectDir, "spell.kdl"),
		});
		expect(result.findings).toEqual([]);
	});

	it("flags every magic-file location when populated", async () => {
		const { detectLegacyConfig } = await import("@oh-my-pi/pi-coding-agent/migration/detect");
		const projectDir = path.join(tmp, "project");
		const agentDir = path.join(tmp, ".spell", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });

		// Populate one of each magic kind.
		fs.writeFileSync(path.join(agentDir, "secrets.yml"), "- type: plain\n  content: x\n");
		fs.writeFileSync(path.join(agentDir, "mcp.json"), '{"mcpServers":{}}');
		fs.writeFileSync(path.join(agentDir, "ssh.json"), '{"hosts":{}}');
		fs.writeFileSync(path.join(projectDir, ".spell", "domain.json"), '{"domain":"x"}');

		const result = await detectLegacyConfig({
			cwd: projectDir,
			agentDir,
			userKdlDest: path.join(tmp, "user.kdl"),
			projectKdlDest: path.join(projectDir, "spell.kdl"),
		});
		const sources = result.findings.map(f => f.source);
		expect(sources.some(s => s.endsWith("secrets.yml"))).toBe(true);
		expect(sources.some(s => s.endsWith("mcp.json"))).toBe(true);
		expect(sources.some(s => s.endsWith("ssh.json"))).toBe(true);
		expect(sources.some(s => s.endsWith("domain.json"))).toBe(true);
	});
});
