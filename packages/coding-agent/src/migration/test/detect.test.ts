/**
 * Unit tests for the legacy-config detector.
 *
 * Lives inside the migration directory so deleting the migrator removes its
 * tests too. No external test fixtures.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { detectLegacyConfig } from "../detect";

let tmpRoot: string;
let userAgentDir: string;
let projectDir: string;
let projectAgentDir: string;
let userDest: string;
let projectDest: string;

beforeEach(() => {
	tmpRoot = path.join(os.tmpdir(), "migration-detect", Snowflake.next());
	userAgentDir = path.join(tmpRoot, "home", ".spell", "agent");
	projectDir = path.join(tmpRoot, "project");
	projectAgentDir = path.join(projectDir, ".spell");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(projectAgentDir, { recursive: true });
	fs.mkdirSync(path.join(projectAgentDir, "agent"), { recursive: true });
	userDest = path.join(tmpRoot, "user-config", "spell.kdl");
	projectDest = path.join(projectDir, "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true });
});

function detect() {
	return detectLegacyConfig({
		cwd: projectDir,
		agentDir: userAgentDir,
		userKdlDest: userDest,
		projectKdlDest: projectDest,
	});
}

describe("detectLegacyConfig", () => {
	it("returns empty when no legacy files exist", async () => {
		const result = await detect();
		expect(result.findings).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	it("detects user-level legacy KDL", async () => {
		const legacy = path.join(path.dirname(userAgentDir), "spell.kdl");
		fs.writeFileSync(legacy, "model { sampling { temperature 0.5 }\n}\n");
		const result = await detect();
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.format).toBe("kdl");
		expect(result.findings[0]?.tier).toBe("user");
		expect(result.findings[0]?.source).toBe(legacy);
		expect(result.findings[0]?.dest).toBe(userDest);
		expect(result.findings[0]?.bytes).toBeGreaterThan(0);
	});

	it("detects user-level legacy YAML", async () => {
		const legacy = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(legacy, "theme:\n  dark: anthracite\n");
		const result = await detect();
		expect(result.findings.find(f => f.format === "yaml")).toBeTruthy();
	});

	it("detects user-level legacy JSON", async () => {
		const legacy = path.join(userAgentDir, "settings.json");
		fs.writeFileSync(legacy, '{"defaultThinkingLevel":"high"}');
		const result = await detect();
		expect(result.findings.find(f => f.format === "json")).toBeTruthy();
	});

	it("detects project-level legacy files", async () => {
		fs.writeFileSync(path.join(projectAgentDir, "spell.kdl"), "");
		fs.writeFileSync(path.join(projectAgentDir, "settings.json"), "{}");
		fs.writeFileSync(path.join(projectAgentDir, "agent", "config.yml"), "");
		const result = await detect();
		const tiers = result.findings.map(f => f.tier);
		expect(tiers.filter(t => t === "project")).toHaveLength(3);
	});

	it("skips sources with a .migrated-*.bak sibling (idempotency)", async () => {
		const legacy = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(legacy, "theme:\n  dark: anthracite\n");
		fs.writeFileSync(`${legacy}.migrated-2026-01-01.bak`, "old");

		const result = await detect();
		expect(result.findings).toEqual([]);
		expect(result.skipped).toContain(legacy);
	});

	it("never proposes source == dest (no-op move)", async () => {
		// Place a file AT the destination — should not appear in findings.
		fs.mkdirSync(path.dirname(userDest), { recursive: true });
		fs.writeFileSync(userDest, "");
		const result = await detect();
		expect(result.findings.find(f => f.source === userDest)).toBeUndefined();
	});

	it("honors skip-forever marker", async () => {
		const legacy = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(legacy, "theme:\n  dark: anthracite\n");

		const marker = path.join(tmpRoot, "skip-forever");
		fs.writeFileSync(marker, "");

		const result = await detectLegacyConfig({
			cwd: projectDir,
			agentDir: userAgentDir,
			userKdlDest: userDest,
			projectKdlDest: projectDest,
			skipMarkerPath: marker,
		});
		expect(result.findings).toEqual([]);
	});

	it("multiple legacy sources from same tier collapse into multiple findings", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "theme: dark");
		fs.writeFileSync(path.join(userAgentDir, "settings.json"), "{}");
		const result = await detect();
		expect(result.findings).toHaveLength(2);
		// Both target the same user destination.
		expect(new Set(result.findings.map(f => f.dest))).toEqual(new Set([userDest]));
	});
});
